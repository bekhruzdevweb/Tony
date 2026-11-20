import "server-only";
import { env } from "../env";
import { anthropicClient, chatWithClaude, describeClaudeError } from "./anthropic";
import { logEvent } from "../events";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/**
 * Tony's conversation, in a form no provider owns. `raw` on an assistant
 * turn is that turn exactly as its provider returned it, kept so it can be
 * sent back unaltered to the same provider.
 */
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

/** The system prompt in two parts: what never changes (cacheable), and what does. */
export type SystemPrompt = { stable: string; live: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** For a 429: how long the provider asked us to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** How long a rate-limited call may wait before trying again. */
const MAX_WAIT_MS = 15_000;

export type Answer = {
  content: string | null;
  tool_calls?: ToolCall[];
  raw?: unknown;
  /** Claude could not answer and the backup model did: never silent (phase e). */
  fallback?: string;
  /** Web pages the answer cites (Claude's web search), and pages it read. */
  sources?: { url: string; title: string }[];
  fetched?: { url: string; title: string }[];
};

/** "Please try again in 7.66s" / "in 1m2.5s", or the Retry-After header, in milliseconds. */
export function retryDelay(status: number, headers: Headers, body: string): number | undefined {
  if (status !== 429) return undefined;
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header * 1000);
  const match = body.match(/try again in (?:(\d+)m)?\s*([\d.]+)(ms|s)/i);
  if (!match) return 5_000;
  const seconds = match[3].toLowerCase() === "ms" ? Number(match[2]) / 1000 : Number(match[2]);
  return Math.ceil((Number(match[1] ?? 0) * 60 + seconds) * 1000);
}

async function callOnce(model: string, system: SystemPrompt, conversation: ChatMessage[], tools: ToolDefinition[], force?: string): Promise<Answer> {
  const apiKey = env.aiApiKey;
  if (!apiKey) throw new ModelError("No Groq key is set (GROQ_API_KEY)");
  // This API takes the system prompt as the first message, and knows nothing of `raw`.
  const messages = [
    { role: "system", content: system.live.trim() ? `${system.stable}\n\n${system.live}` : system.stable },
    ...conversation.map((message) => (message.role === "assistant" ? { role: message.role, content: message.content, tool_calls: message.tool_calls } : message)),
  ];

  let response: Response;
  try {
    response = await fetch(`${env.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools,
        // `force` names a tool the model must call (used when a structured answer is needed).
        tool_choice: force ? { type: "function", function: { name: force } } : "auto",
        temperature: 0.3,
        // Tony's replies are short; a modest ceiling keeps one call from reserving a large share of the minute's allowance.
        max_tokens: 1200,
        ...(env.aiReasoningEffort ? { reasoning_effort: env.aiReasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new ModelError(`Model unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new ModelError(`${model} answered ${response.status}: ${detail}`, response.status, retryDelay(response.status, response.headers, detail));
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const message = body.choices?.[0]?.message;
  if (!message) throw new ModelError("Model returned no message");
  if (body.usage) {
    // In the logs, so the real cost of a message can be read off rather than guessed.
    console.log(`Model ${model}: ${body.usage.prompt_tokens} in + ${body.usage.completion_tokens} out = ${body.usage.total_tokens} tokens; minute allowance left: ${response.headers.get("x-ratelimit-remaining-tokens") ?? "?"}`);
  }
  return { content: message.content ?? null, tool_calls: message.tool_calls?.length ? message.tool_calls : undefined };
}

/**
 * The second model: an OpenAI-compatible chat API (Groq). When it says
 * "too many tokens this minute" (429), wait the time it names and try once
 * more; if that fails, use its own smaller stand-in, which has a separate
 * allowance.
 */
async function chatWithGroq(system: SystemPrompt, messages: ChatMessage[], tools: ToolDefinition[], force?: string): Promise<Answer> {
  try {
    return await callOnce(env.aiModel, system, messages, tools, force);
  } catch (first) {
    if (!(first instanceof ModelError) || first.status !== 429) throw first;
    console.warn(`Rate limited: ${first.message}`);

    const wait = first.retryAfterMs ?? 5_000;
    if (wait <= MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait + 250));
      try {
        return await callOnce(env.aiModel, system, messages, tools, force);
      } catch (second) {
        if (!(second instanceof ModelError) || second.status !== 429) throw second;
        console.warn(`Still rate limited after waiting ${wait} ms.`);
      }
    }

    const fallback = env.aiFallbackModel;
    if (fallback && fallback !== env.aiModel) {
      console.warn(`Using the fallback model ${fallback}.`);
      return await callOnce(fallback, system, messages, tools, force);
    }
    throw first;
  }
}

/**
 * One turn of Tony's brain. Claude (Anthropic) answers; if that fails for
 * any reason (rate limit, outage, a bad key, a refusal), the same request
 * goes to the second model on Groq, so he is not left without an answer.
 * With no Anthropic key at all, Groq is the brain, as it was before.
 */
export async function chat(input: {
  system: SystemPrompt | string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  force?: string;
  web?: boolean;
  model?: string;
  /** Advice and discussion: more thought, and room for a full answer. */
  depth?: "deep";
}): Promise<Answer> {
  const system = typeof input.system === "string" ? { stable: input.system, live: "" } : input.system;
  const claude = anthropicClient();
  if (claude) {
    try {
      return await chatWithClaude(claude, system, input.messages, input.tools, input.force, input.web, input.model, input.depth);
    } catch (error) {
      console.error(`Claude failed, ${env.aiApiKey ? `falling back to ${env.aiModel}` : "and there is no fallback"}: ${describeClaudeError(error)}`);
      if (!env.aiApiKey) throw new ModelError(`Claude failed: ${describeClaudeError(error)}`);
      // Every fallback is noted, and the answer says it came from the backup model (phase e).
      void logEvent("model_fallback", { from: input.model ?? env.anthropicModel, to: env.aiModel, error: describeClaudeError(error).slice(0, 300) });
      const answer = await chatWithGroq(system, input.messages, input.tools, input.force);
      return { ...answer, fallback: describeClaudeError(error).slice(0, 120) };
    }
  }
  return chatWithGroq(system, input.messages, input.tools, input.force);
}

/** The morning self-test: Claude answers a one-word request, or why it did not. */
export async function checkClaude(): Promise<string | undefined> {
  const claude = anthropicClient();
  if (!claude) return "no Anthropic key is set";
  try {
    const answer = await chatWithClaude(claude, { stable: "Reply with the single word OK.", live: "" }, [{ role: "user", content: "Self-test. Reply OK." }], []);
    return answer.content?.trim() ? undefined : "it gave an empty answer";
  } catch (error) {
    return describeClaudeError(error).slice(0, 160);
  }
}

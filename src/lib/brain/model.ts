import "server-only";
import { env } from "../env";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

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

type Answer = { content: string | null; tool_calls?: ToolCall[] };

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

async function callOnce(model: string, messages: ChatMessage[], tools: ToolDefinition[], force?: string): Promise<Answer> {
  const apiKey = env.aiApiKey;
  if (!apiKey) throw new ModelError("AI_API_KEY is not set");

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
 * One call to an OpenAI-compatible chat API. Provider and model are plain
 * settings (AI_BASE_URL, AI_MODEL), so swapping them needs no code change.
 *
 * When the provider says "too many tokens this minute" (429): wait the time
 * it names and try once more; if the wait is too long or the retry fails,
 * use the fallback model, which has its own allowance. Only then give up.
 */
export async function chat(messages: ChatMessage[], tools: ToolDefinition[], force?: string): Promise<Answer> {
  try {
    return await callOnce(env.aiModel, messages, tools, force);
  } catch (first) {
    if (!(first instanceof ModelError) || first.status !== 429) throw first;
    console.warn(`Rate limited: ${first.message}`);

    const wait = first.retryAfterMs ?? 5_000;
    if (wait <= MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait + 250));
      try {
        return await callOnce(env.aiModel, messages, tools, force);
      } catch (second) {
        if (!(second instanceof ModelError) || second.status !== 429) throw second;
        console.warn(`Still rate limited after waiting ${wait} ms.`);
      }
    }

    const fallback = env.aiFallbackModel;
    if (fallback && fallback !== env.aiModel) {
      console.warn(`Using the fallback model ${fallback}.`);
      return await callOnce(fallback, messages, tools, force);
    }
    throw first;
  }
}

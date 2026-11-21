import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "../safety";
import { env } from "../env";
import type { Answer, ChatMessage, SystemPrompt, ToolCall, ToolDefinition } from "./model";

/**
 * Tony's main brain: Claude, through the Anthropic API.
 *
 * Prompt caching: a request is laid out as tools, then system, then
 * messages, and the cache works on that prefix. The tool definitions and
 * the stable half of the system prompt never change between messages, so a
 * cache breakpoint is put at the end of the stable half; everything that
 * does change (the time, the tasks, the memory, the conversation) comes
 * after it. Within five minutes of the last message the stable part is
 * read from the cache at a tenth of the price.
 */
let cached: { key: string; client: Anthropic } | undefined;

export function anthropicClient(): Anthropic | undefined {
  const apiKey = env.anthropicApiKey;
  if (!apiKey) return undefined;
  if (cached?.key === apiKey) return cached.client;
  // One retry inside the SDK (it honours the server's retry-after), then
  // Tony falls back to his second model rather than keep him waiting.
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
  cached = { key: apiKey, client };
  return client;
}

/** Tony's provider-neutral conversation, as Anthropic message params. */
function toMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // All the results of one assistant turn go back in a single user message.
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content };
      const previous = out[out.length - 1];
      if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every((part) => part.type === "tool_result")) {
        previous.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (message.role === "assistant") {
      // A turn Claude itself produced is replayed exactly as it came back,
      // thinking blocks included: they must not be altered or dropped.
      if (message.raw) {
        out.push({ role: "assistant", content: message.raw as Anthropic.ContentBlockParam[] });
        continue;
      }
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content?.trim()) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
    } else if (message.content.trim()) {
      out.push({ role: "user", content: message.content });
    }
  }
  // A conversation must open with the user.
  while (out.length > 0 && out[0].role !== "user") out.shift();
  // Two turns of the same role in a row (a reminder Tony sent, then his reply) are joined into one.
  const merged: Anthropic.MessageParam[] = [];
  for (const message of out) {
    const last = merged[merged.length - 1];
    if (!last || last.role !== message.role) {
      merged.push(message);
      continue;
    }
    const blocks = (content: Anthropic.MessageParam["content"]): Anthropic.ContentBlockParam[] => (typeof content === "string" ? [{ type: "text", text: content }] : content);
    last.content = [...blocks(last.content), ...blocks(message.content)];
  }
  return merged;
}

const toTools = (tools: ToolDefinition[]): Anthropic.Tool[] =>
  tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
  }));

/** A web page Claude cited or read. */
export type WebSource = { url: string; title: string };

/**
 * Anthropic's own web tools, run on Anthropic's side. Haiku takes the
 * basic versions (the newer ones, with dynamic filtering, are for larger
 * models). At most three searches and two page reads per reply.
 */
const WEB_TOOLS: Anthropic.ToolUnion[] = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: { type: "approximate", timezone: "Asia/Samarkand" } },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, citations: { enabled: true }, max_content_tokens: 8000 },
];
/** At least medium effort, never less than what is configured. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
function deeper(effort: (typeof EFFORTS)[number]): (typeof EFFORTS)[number] {
  return EFFORTS.indexOf(effort) >= 1 ? effort : "medium";
}

/** If the account refuses the web tools (not enabled for it), they are left out for an hour. */
let webOffUntil = 0;
const MAX_PAUSES = 3;

const SERVER_BLOCKS = new Set(["server_tool_use", "web_search_tool_result", "web_fetch_tool_result"]);

/**
 * One call to Claude. Throws on any failure (including a refusal), so the
 * caller can fall back to the second model.
 */
export async function chatWithClaude(
  client: Anthropic,
  system: SystemPrompt,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  force?: string,
  web = false,
  model = env.anthropicModel,
  depth?: "deep",
): Promise<Answer> {
  const useWeb = web && Date.now() > webOffUntil;
  const request = (conversation: Anthropic.MessageParam[], withWeb: boolean) =>
    client.messages.create({
      model,
      // Thinking counts towards this: generous for a sentence or two, and twice that for a full answer to advice.
      max_tokens: depth === "deep" ? 8000 : 4000,
      // Routing a request to a tool is light work; advice and discussion get at least medium effort (never less than configured).
      output_config: { effort: depth === "deep" ? deeper(env.anthropicEffort) : env.anthropicEffort },
      system: [
        { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
        ...(system.live.trim() ? [{ type: "text" as const, text: system.live }] : []),
        // Thinking models refuse a forced tool_choice, so the one tool is offered alone and asked for.
        ...(force ? [{ type: "text" as const, text: `Answer now by calling the ${force} tool. Do not reply in text.` }] : []),
      ],
      tools: force ? toTools(tools.filter((tool) => tool.function.name === force)) : [...toTools(tools), ...(withWeb ? WEB_TOOLS : [])],
      // `force` names a tool the model must call (used when a structured answer is needed).
      tool_choice: { type: "auto" },
      messages: conversation,
    });

  let conversation = toMessages(messages);
  let withWeb = useWeb;
  const content: Anthropic.ContentBlock[] = [];
  let response: Anthropic.Message | undefined;
  for (let pause = 0; pause <= MAX_PAUSES; pause++) {
    try {
      response = await request(conversation, withWeb);
    } catch (error) {
      // The web tools may not be enabled for the account: answer without them rather than not at all.
      if (withWeb && error instanceof Anthropic.BadRequestError && /web_(search|fetch)|server tool/i.test(error.message)) {
        console.error(`Web tools refused, answering without them for an hour: ${error.message}`);
        webOffUntil = Date.now() + 60 * 60_000;
        withWeb = false;
        response = await request(conversation, false);
      } else {
        throw error;
      }
    }
    content.push(...response.content);
    // A long search can pause the turn; sending it back lets Anthropic carry on where it stopped.
    if (response.stop_reason !== "pause_turn") break;
    conversation = [...conversation, { role: "assistant", content: response.content as Anthropic.ContentBlockParam[] }];
  }
  if (!response) throw new Error("Claude gave no response");

  // In the logs, so cost and cache use can be read off rather than guessed.
  const usage = response.usage;
  const searches = usage.server_tool_use ? `, ${usage.server_tool_use.web_search_requests ?? 0} searches, ${usage.server_tool_use.web_fetch_requests ?? 0} page reads` : "";
  console.log(
    `Claude ${response.model}: ${usage.input_tokens} in (+${usage.cache_read_input_tokens ?? 0} from cache, +${usage.cache_creation_input_tokens ?? 0} written to cache), ${usage.output_tokens} out${searches}; stop: ${response.stop_reason}`,
  );
  // Noted for the budget guard (phase e): what this call cost.
  recordUsage({ model: response.model, input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
  }

  // The answer is the text after the last search or page read; anything before it was "let me look".
  let lastServer = -1;
  content.forEach((block, index) => {
    if (SERVER_BLOCKS.has(block.type)) lastServer = index;
  });
  const texts = content.filter((block, index): block is Anthropic.TextBlock => block.type === "text" && index > lastServer);
  // A cited answer arrives in pieces (one block per citation), so they are joined as they are.
  const text = texts.map((block) => block.text).join("").trim();
  const calls: ToolCall[] = content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));

  // Sources: the pages the answer cites; failing that, the first few results it searched.
  const sources = new Map<string, string>();
  for (const block of texts) {
    for (const citation of block.citations ?? []) {
      if (citation.type === "web_search_result_location" && !sources.has(citation.url)) sources.set(citation.url, citation.title ?? citation.url);
    }
  }
  const fetched: WebSource[] = [];
  for (const block of content) {
    if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
      fetched.push({ url: block.content.url, title: block.content.content.title ?? block.content.url });
    }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content) && sources.size === 0 && text) {
      for (const result of block.content.slice(0, 3)) sources.set(result.url, result.title || result.url);
    }
  }

  return {
    content: text || null,
    tool_calls: calls.length ? calls : undefined,
    raw: content,
    sources: [...sources].map(([url, title]) => ({ url, title })),
    fetched,
  };
}

/** Reads an image with Claude: the text in it, word for word, and what it shows. */
export async function readImageWithClaude(client: Anthropic, bytes: ArrayBuffer, mime: string, instruction: string): Promise<string> {
  const media = (["image/jpeg", "image/png", "image/gif", "image/webp"] as const).find((type) => type === mime) ?? "image/jpeg";
  const response = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: media, data: Buffer.from(bytes).toString("base64") } },
          { type: "text", text: instruction },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to read the image");
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Reads a PDF with Claude (22 Nov: "can u see my ielts plan?" got "I can't open that document"). Fast
 * model, a bounded answer and a time limit: it runs before Tony answers, inside the webhook's minute.
 */
export async function readPdfWithClaude(client: Anthropic, bytes: ArrayBuffer, instruction: string, title?: string): Promise<{ text: string; cut: boolean }> {
  const response = await client.messages.create(
    {
      model: env.anthropicReaderModel,
      max_tokens: 3000,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") }, ...(title ? { title } : {}) },
            { type: "text", text: instruction },
          ],
        },
      ],
    },
    { timeout: 30_000, maxRetries: 0 },
  );
  if (response.stop_reason === "refusal") throw new Error("Claude declined to read the document");
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return { text, cut: response.stop_reason === "max_tokens" };
}

/** A short answer from the fast model, for small jobs (a document's one-line summary); bounded in time. */
export async function quickAnswer(client: Anthropic, prompt: string, options: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  const response = await client.messages.create(
    { model: env.anthropicReaderModel, max_tokens: options.maxTokens ?? 200, messages: [{ role: "user", content: prompt }] },
    { timeout: options.timeoutMs ?? 12_000, maxRetries: 0 },
  );
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** A short description of an Anthropic failure for the log, by kind. */
export function describeClaudeError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return `rate limited (429): ${error.message}`;
  if (error instanceof Anthropic.AuthenticationError) return "the API key was rejected (401): check ANTHROPIC_API_KEY";
  if (error instanceof Anthropic.PermissionDeniedError) return `not permitted (403): ${error.message}`;
  if (error instanceof Anthropic.NotFoundError) return `model not found (404): check ANTHROPIC_MODEL (${env.anthropicModel})`;
  if (error instanceof Anthropic.BadRequestError) return `bad request (400): ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return `could not connect: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `API error ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

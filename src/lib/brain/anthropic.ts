import "server-only";
import Anthropic from "@anthropic-ai/sdk";
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
  return out;
}

const toTools = (tools: ToolDefinition[]): Anthropic.Tool[] =>
  tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
  }));

/**
 * One call to Claude. Throws on any failure (including a refusal), so the
 * caller can fall back to the second model.
 */
export async function chatWithClaude(client: Anthropic, system: SystemPrompt, messages: ChatMessage[], tools: ToolDefinition[], force?: string): Promise<Answer> {
  const response = await client.messages.create({
    model: env.anthropicModel,
    // Thinking counts towards this, so it is generous for replies that are a sentence or two.
    max_tokens: 4000,
    // Routing a request to a tool and wording a short reply is light work; the model still thinks when it needs to.
    output_config: { effort: env.anthropicEffort },
    system: [
      { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
      ...(system.live.trim() ? [{ type: "text" as const, text: system.live }] : []),
    ],
    tools: toTools(tools),
    // `force` names a tool the model must call (used when a structured answer is needed).
    tool_choice: force ? { type: "tool", name: force } : { type: "auto" },
    messages: toMessages(messages),
  });

  // In the logs, so cost and cache use can be read off rather than guessed.
  const usage = response.usage;
  console.log(
    `Claude ${response.model}: ${usage.input_tokens} in (+${usage.cache_read_input_tokens ?? 0} from cache, +${usage.cache_creation_input_tokens ?? 0} written to cache), ${usage.output_tokens} out; stop: ${response.stop_reason}`,
  );

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
  }

  // Blocks are read by type: a reply can open with thinking, and text and tool calls can be mixed.
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const calls: ToolCall[] = response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));

  return { content: text || null, tool_calls: calls.length ? calls : undefined, raw: response.content };
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

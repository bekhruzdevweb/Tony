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
  ) {
    super(message);
  }
}

/**
 * One call to an OpenAI-compatible chat API. Provider and model are plain
 * settings (AI_BASE_URL, AI_MODEL), so swapping them needs no code change.
 */
export async function chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const apiKey = env.aiApiKey;
  if (!apiKey) throw new ModelError("AI_API_KEY is not set");

  let response: Response;
  try {
    response = await fetch(`${env.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: env.aiModel, messages, tools, tool_choice: "auto", temperature: 0.3 }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new ModelError(`Model unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ModelError(`Model answered ${response.status}: ${detail}`, response.status);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
  const message = body.choices?.[0]?.message;
  if (!message) throw new ModelError("Model returned no message");
  return { content: message.content ?? null, tool_calls: message.tool_calls?.length ? message.tool_calls : undefined };
}

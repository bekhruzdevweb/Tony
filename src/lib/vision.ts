import "server-only";
import { anthropicClient, describeClaudeError, readImageWithClaude } from "./brain/anthropic";
import { env } from "./env";

/** Photos are sent to the model inline; keep them well under its request limit. */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

const INSTRUCTION =
  "Transcribe all the text in this image exactly as written, in its original language. Then, on a new line starting with 'Shows:', say in one English sentence what the image is. If there is no text, write only the 'Shows:' line.";

/** The fallback reader: a vision model on Groq. */
async function readWithGroq(bytes: ArrayBuffer, mime: string): Promise<string> {
  const apiKey = env.aiApiKey;
  if (!apiKey) throw new Error("No Groq key is set (GROQ_API_KEY)");
  const response = await fetch(`${env.aiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: env.visionModel,
      temperature: 0,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: INSTRUCTION },
            { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${env.visionModel} answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
  return (body.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Reads a photo: the text in it, word for word in its own language, and a
 * line on what it shows. Claude reads it; if Claude cannot, a vision model
 * on Groq does. Throws if neither can be reached.
 */
export async function readImage(bytes: ArrayBuffer, mime = "image/jpeg"): Promise<string> {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  const claude = anthropicClient();
  if (claude) {
    try {
      const text = await readImageWithClaude(claude, bytes, mime, INSTRUCTION);
      if (text) return text.slice(0, 1500);
      console.warn("Claude returned nothing for the image.");
    } catch (error) {
      console.error(`Claude could not read the image: ${describeClaudeError(error)}`);
      if (!env.aiApiKey) throw error;
    }
  }
  return (await readWithGroq(bytes, mime)).slice(0, 1500);
}

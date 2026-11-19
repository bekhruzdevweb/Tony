import "server-only";
import { env } from "./env";

/** Photos are sent to the model inline; keep them well under its request limit. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Reads a photo: the text in it, word for word in its own language, and a
 * line on what it shows. Uses a vision-capable model on the same provider
 * and key as the brain. Throws if the model cannot be reached.
 */
export async function readImage(bytes: ArrayBuffer, mime = "image/jpeg"): Promise<string> {
  const apiKey = env.aiApiKey;
  if (!apiKey) throw new Error("AI_API_KEY is not set");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");

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
            {
              type: "text",
              text: "Transcribe all the text in this image exactly as written, in its original language. Then, on a new line starting with 'Shows:', say in one English sentence what the image is. If there is no text, write only the 'Shows:' line.",
            },
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
  return (body.choices?.[0]?.message?.content ?? "").trim().slice(0, 1500);
}

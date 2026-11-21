import "server-only";
import { anthropicClient, describeClaudeError, readImageWithClaude, readPdfWithClaude } from "./brain/anthropic";
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

/** PDFs are sent to the model whole; keep them well under its request limit (32 MB, base64 adds a third). */
const MAX_PDF_BYTES = 12 * 1024 * 1024;
/** What is kept of a document's text: enough for a plan or a worksheet, not a book. */
const DOCUMENT_CHARS = 12_000;

const PDF_INSTRUCTION = [
  "Read this document. Answer in exactly this form, with nothing before it:",
  "Summary: one or two plain English sentences: what it is and what it covers.",
  "Text:",
  "the document's text, word for word in its own language, as plain text: headings, list items and table rows each on their own line; leave out page numbers and headers or footers repeated on every page.",
].join("\n");

/** A document he can mean by its kind: a PDF, or plain text (txt, md, csv, json). */
export function readableDocument(mime: string, name = ""): "pdf" | "text" | undefined {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^text\//.test(mime) || mime === "application/json" || /\.(txt|md|csv|json)$/i.test(name)) return "text";
  return undefined;
}

/**
 * Reads a document he sent: a PDF with Claude (a summary line, then its text), a plain text file as it
 * is. Undefined for anything else. Throws when a PDF cannot be read (too large, or Claude unreachable).
 */
export async function readDocument(bytes: ArrayBuffer, mime: string, name = ""): Promise<string | undefined> {
  const kind = readableDocument(mime, name);
  if (kind === "text") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    return text.length > DOCUMENT_CHARS ? `${text.slice(0, DOCUMENT_CHARS)}\n(… the file goes on)` : text;
  }
  if (kind !== "pdf") return undefined;
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("document too large");
  const claude = anthropicClient();
  if (!claude) throw new Error("no Anthropic key: PDFs are read by Claude only");
  const read = await readPdfWithClaude(claude, bytes, PDF_INSTRUCTION, name || undefined);
  if (!read.text) throw new Error("Claude returned nothing for the document");
  const text = read.text.length > DOCUMENT_CHARS ? read.text.slice(0, DOCUMENT_CHARS) : read.text;
  return read.cut || read.text.length > DOCUMENT_CHARS ? `${text}\n(… the document goes on; this is the first part)` : text;
}

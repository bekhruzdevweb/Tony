import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import { anthropicClient, describeClaudeError, quickAnswer, readImageWithClaude, readPdfWithClaude } from "./brain/anthropic";
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

/** PDFs read by Claude (scanned ones, with no text layer) are sent whole; keep them under its request limit. */
const MAX_PDF_BYTES = 12 * 1024 * 1024;
/** What is kept of a document's text: a whole study plan or worksheet, not a book. */
export const DOCUMENT_CHARS = 60_000;
/** The end of a document's text when the rest was not kept. */
export const CUT_MARK = "(… the rest of the document was not kept)";
/** How the first reader (Claude, 22 Nov 02:00) ended a PDF it could not finish: such a text is read again. */
export const OLD_CUT_MARK = "(… the document goes on; this is the first part)";

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

/** The text layer of a PDF, page by page ("" for a scanned one): read in code, whole, in well under a second. */
export async function pdfText(bytes: ArrayBuffer): Promise<{ pages: number; text: string }> {
  // A copy: the reader may take the buffer over, and Claude may still need it.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((page) => page.replace(/[ \t]+\n/g, "\n").trim());
  const joined = pages.length > 1 ? pages.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n\n") : (pages[0] ?? "");
  return { pages: totalPages, text: pages.join("").trim() ? joined.trim() : "" };
}

const keep = (text: string) => (text.length > DOCUMENT_CHARS ? `${text.slice(0, DOCUMENT_CHARS)}\n${CUT_MARK}` : text);

/**
 * Reads a document he sent: a PDF's own text, whole (22 Nov: Claude's reading of the IELTS plan stopped at
 * week 3), with a one-line summary from the fast model; a scanned PDF (no text in it) is read by Claude;
 * a plain text file as it is. Undefined for anything else. Throws when a PDF cannot be read at all.
 */
export async function readDocument(bytes: ArrayBuffer, mime: string, name = ""): Promise<string | undefined> {
  const kind = readableDocument(mime, name);
  if (kind === "text") return keep(`Text:\n${new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim()}`);
  if (kind !== "pdf") return undefined;
  const claude = anthropicClient();
  const layer = await pdfText(bytes).catch((error) => (console.error("Could not take the PDF's text:", error), { pages: 0, text: "" }));
  if (layer.text.replace(/--- page \d+ ---/g, "").trim().length >= 80) {
    const summary = claude
      ? await quickAnswer(claude, `In one or two plain English sentences, say what this document is and what it covers. Answer with the sentences only.\n\n${layer.text.slice(0, 6_000)}`).catch(
          (error) => (console.error(`No summary for the PDF: ${describeClaudeError(error)}`), ""),
        )
      : "";
    return keep([summary ? `Summary: ${summary.replace(/^Summary:\s*/i, "").replace(/\s+/g, " ")}` : undefined, `Pages: ${layer.pages}`, "Text:", layer.text].filter(Boolean).join("\n"));
  }
  // No text in it (a scan or a photo of pages): Claude reads the pages.
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("document too large");
  if (!claude) throw new Error("no Anthropic key: scanned PDFs are read by Claude only");
  const read = await readPdfWithClaude(claude, bytes, PDF_INSTRUCTION, name || undefined);
  if (!read.text) throw new Error("Claude returned nothing for the document");
  return read.cut ? `${keep(read.text)}\n${CUT_MARK}` : keep(read.text);
}

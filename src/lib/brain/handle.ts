import "server-only";
import { asksToClean } from "./checks";
import { think } from "./index";
import { splitIntents } from "./reliability";
import { logEvent } from "../events";
import { asksForLink } from "../link-rules";
import { linkReply } from "../links";
import { asksForMedia, findMedia } from "../media";
import { logMessage, type Channel } from "../messages";

export type Thought = Awaited<ReturnType<typeof think>>;

/** One request from his message, and how it was handled. */
export type Handled =
  | { text: string; kind: "clean" }
  /** "Send me the video": the link itself, found in plain code. */
  | { text: string; kind: "link"; reply: string }
  /** "Send me that photo": the originals, found in plain code; the bot sends them and confirms only what Telegram delivered. */
  | { text: string; kind: "media"; ids: number[] }
  /** "Undo that": the last changes, to undo with a tap. */
  | { text: string; kind: "undo" }
  | { text: string; kind: "thought"; thought: Thought }
  | { text: string; kind: "failed"; reply: string };

/** Said when the model cannot be reached even after a retry. Nothing he said is turned into a task; the failure is logged. */
export const UNAVAILABLE = "I didn't catch that, sir.";

const RETRY_MS = 1500;

/** What Tony says after cleaning the chat. */
export const CLEANED = "Chat cleaned, sir.";

/** "Undo", "undo that", "undo the last one". */
export const asksToUndo = (text: string) => /^\s*(please\s+)?undo\b|\bundo (that|it|this|the last|my last|last)\b/i.test(text);

/**
 * His message, request by request: split where he clearly asked for several
 * things, each handled on its own and each confirmed on its own. "Clean the
 * chat", "send me that photo", "send me the link" and "undo" are plain code;
 * the rest goes to the brain. If the model fails, it is tried once more; if
 * it fails again, he hears "I didn't catch that, sir.", nothing is saved,
 * and the failure is logged.
 */
export async function handleMessage(
  text: string,
  options: { channel?: Channel; context?: string; split?: boolean; now?: () => Date; wait?: (ms: number) => Promise<void> } = {},
): Promise<Handled[]> {
  const { channel = "telegram", context, split = true } = options;
  const clock = options.now ?? (() => new Date());
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const parts = split ? splitIntents(text) : [text];
  const handled: Handled[] = [];
  // His message goes into the history once, whole, whichever request handles it first.
  let logged = false;
  const logHis = async () => {
    if (logged) return;
    logged = true;
    await logMessage("user", text, channel).catch(() => undefined);
  };
  for (const [index, part] of parts.entries()) {
    if (asksToClean(part) && part.split(/\s+/).length <= 8) {
      await logHis();
      // Tony's answer is logged too, so the history keeps taking turns (two of his messages in a row would merge).
      await logMessage("tony", CLEANED, channel).catch(() => undefined);
      handled.push({ text: part, kind: "clean" });
      continue;
    }
    if (asksToUndo(part)) {
      await logHis();
      handled.push({ text: part, kind: "undo" });
      continue;
    }
    // "Send me that photo": the original, at once. A video counts only if a saved video matches; otherwise it is a link.
    const wantsFile = /\b(photos?|pictures?|pics?|images?|screenshots?|files?|documents?)\b/i.test(part);
    if (asksForMedia(part) && (wantsFile || /\bvideos?\b/i.test(part))) {
      const found = await findMedia(part, 3, clock()).catch((error) => (console.error("Media lookup failed:", error), []));
      const usable = wantsFile ? found : found.filter((item) => item.kind === "video" || item.kind === "animation");
      if (usable.length > 0) {
        await logHis();
        handled.push({ text: part, kind: "media", ids: usable.map((item) => item.id) });
        continue;
      }
    }
    // "Send me the video": answered with the link at once.
    if (asksForLink(part) && !wantsFile) {
      const reply = await linkReply(part, clock()).catch((error) => (console.error("Link lookup failed:", error), undefined));
      if (reply) {
        await logHis();
        await logMessage("tony", reply, channel).catch(() => undefined);
        handled.push({ text: part, kind: "link", reply });
        continue;
      }
    }
    const piece = parts.length > 1 ? { index, total: parts.length, full: text } : undefined;
    // The brain logs his message itself unless it already is in the history (and not again on a retry).
    const run = async () => {
      const already = logged;
      logged = true;
      return think(part, { channel, context, now: clock(), part: piece, logged: already });
    };
    try {
      handled.push({ text: part, kind: "thought", thought: await run() });
    } catch (first) {
      console.error("Brain failed, trying once more:", first);
      await wait(RETRY_MS);
      try {
        handled.push({ text: part, kind: "thought", thought: await run() });
      } catch (second) {
        console.error("Brain failed again:", second);
        await logEvent("ai_failure", { text: part, channel, error: String(second instanceof Error ? second.message : second).slice(0, 500) });
        await logMessage("tony", UNAVAILABLE, channel).catch(() => undefined);
        handled.push({ text: part, kind: "failed", reply: UNAVAILABLE });
      }
    }
  }
  return handled;
}

import "server-only";
import { asksToClean } from "./checks";
import { think } from "./index";
import { splitIntents } from "./reliability";
import { logMessage, type Channel } from "../messages";

export type Thought = Awaited<ReturnType<typeof think>>;

/** One request from his message, and how it was handled. */
export type Handled =
  | { text: string; kind: "clean" }
  | { text: string; kind: "thought"; thought: Thought }
  | { text: string; kind: "failed"; reply: string };

/** Said when the model cannot be reached even after a retry. Nothing he said is turned into a task. */
export const UNAVAILABLE = "My thinking is briefly unavailable, sir, and nothing was saved. Please send that again in a minute.";

const RETRY_MS = 1500;

/** What Tony says after cleaning the chat. */
export const CLEANED = "Chat cleaned, sir.";

/**
 * His message, request by request: split where he clearly asked for several
 * things, each handled on its own ("clean the chat" in plain code, the rest
 * by the brain) and each confirmed on its own. If the model fails, it is
 * tried once more; if it fails again, he is told and nothing is saved.
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
  for (const [index, part] of parts.entries()) {
    if (asksToClean(part) && part.split(/\s+/).length <= 8) {
      // Logged once, whole, like any other message.
      if (index === 0) await logMessage("user", text, channel).catch(() => undefined);
      // Tony's answer is logged too, so the history keeps taking turns (two of his messages in a row would merge).
      await logMessage("tony", CLEANED, channel).catch(() => undefined);
      handled.push({ text: part, kind: "clean" });
      continue;
    }
    const piece = parts.length > 1 ? { index, total: parts.length, full: text } : undefined;
    // His message is logged by the first request only (or by a clean before it), and not again on a retry.
    let logged = handled.length > 0;
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
        await logMessage("tony", UNAVAILABLE, channel).catch(() => undefined);
        handled.push({ text: part, kind: "failed", reply: UNAVAILABLE });
      }
    }
  }
  return handled;
}

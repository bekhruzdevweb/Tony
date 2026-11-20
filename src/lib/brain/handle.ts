import "server-only";
import { asksToClean } from "./checks";
import { think } from "./index";
import { splitIntents } from "./reliability";
import { logEvent } from "../events";
import { asksForLink } from "../link-rules";
import { linkReply } from "../links";
import { asksForMedia, findMedia } from "../media";
import { logMessage, type Channel } from "../messages";
import { setPendingSlot, waitingSlot } from "../settings";
import { addStepsInCode, placeTypedTime } from "../slots";
import { findInLibrary } from "../library";
import { itemLabel } from "../library-rules";
import { rulesView } from "../rules";
import { suggestFreeTime } from "../free-time";
import { asksForRules, saysFree } from "../smart-rules";
import { requireDb } from "../db";

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
  /** The time he typed after [✏️ Other time] (or the steps after [🧩 Steps]), placed in plain code. */
  | { text: string; kind: "placed"; reply: string }
  /** "Send me that video" with two items fitting equally: he picks, with their titles. */
  | { text: string; kind: "choose"; question: string; options: { text: string; data: string }[] }
  /** "I'm free", "I'm bored": one item from the 🌙 Free Time list, with its buttons. */
  | { text: string; kind: "free"; reply: string; rows: { text: string; data: string }[][] }
  /** "Show my rules": the list, each with 🗑. */
  | { text: string; kind: "rules"; reply: string; rows: { text: string; data: string }[][] }
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
  const { channel = "telegram", split = true } = options;
  let context = options.context;
  const clock = options.now ?? (() => new Date());
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const handled: Handled[] = [];
  // His message goes into the history once, whole, whichever request handles it first.
  let logged = false;
  const logHis = async () => {
    if (logged) return;
    logged = true;
    await logMessage("user", text, channel).catch(() => undefined);
  };

  // He tapped [✏️ Other time]: a plain time is placed in code, at once; anything else goes to the brain, told what he is answering.
  const slot = await waitingSlot(clock()).catch(() => undefined);
  // He tapped [🧩 Steps] on a task that slipped: the lines he types are its parts, added in code.
  if (slot && "steps" in slot) {
    await setPendingSlot(null, clock());
    const steps = text.split(/\n|;|,(?![^(]*\))|\s+then\s+/i).map((step) => step.replace(/^\s*(\d+[.)]|[-•*])\s*/, "").trim()).filter((step) => step.length > 1);
    if (steps.length >= 1 && steps.length <= 12 && text.length <= 600) {
      await logHis();
      const reply = await addStepsInCode(slot.task_id, steps);
      await logMessage("tony", reply, channel).catch(() => undefined);
      return [{ text, kind: "placed", reply }];
    }
  }
  if (slot && "day" in slot) {
    await setPendingSlot(null, clock());
    const placed = await placeTypedTime(text, slot, clock()).catch((error) => (console.error("Typed time failed:", error), undefined));
    if (placed) {
      await logHis();
      await logMessage("tony", placed.text, channel).catch(() => undefined);
      return [{ text, kind: "placed", reply: placed.text }];
    }
    const found = await requireDb().from("tasks").select("title").eq("id", slot.task_id).maybeSingle();
    const title = (found.data as { title?: string } | null)?.title;
    if (title) context = [context, `He tapped "Other time" for task #${slot.task_id} "${title}" on ${slot.day}: this message is the time he wants. Set it with update_task (due_at on ${slot.day}).`].filter(Boolean).join(" ");
  }

  // "I'm free", "I'm bored": one item from his 🌙 Free Time list, in code (phase c).
  if (saysFree(text)) {
    const suggestion = await suggestFreeTime(clock(), { asked: true }).catch((error) => (console.error("Free time failed:", error), undefined));
    if (suggestion) {
      await logHis();
      await logMessage("tony", suggestion.text, channel).catch(() => undefined);
      return [{ text, kind: "free", reply: suggestion.text, rows: suggestion.rows }];
    }
  }
  // "Show my rules": the list, in code (phase b).
  if (asksForRules(text)) {
    const view = await rulesView(clock());
    await logHis();
    await logMessage("tony", view.text, channel).catch(() => undefined);
    return [{ text, kind: "rules", reply: view.text, rows: view.rows }];
  }

  const parts = split ? splitIntents(text) : [text];
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
    // Nothing recent fits: his library, everything he ever sent ("that Instagram video", "the photo I sent yesterday").
    if (asksForMedia(part) || asksForLink(part)) {
      const found = await findInLibrary(part, clock()).catch(() => ({}) as Awaited<ReturnType<typeof findInLibrary>>);
      if (found.found) {
        await logHis();
        if (found.found.source === "media") {
          handled.push({ text: part, kind: "media", ids: [found.found.id] });
        } else {
          const reply = `${itemLabel(found.found, clock())}${found.found.url ? `\n${found.found.url}` : found.found.description ? `\n${found.found.description}` : ""}`;
          await logMessage("tony", reply, channel).catch(() => undefined);
          handled.push({ text: part, kind: "link", reply });
        }
        continue;
      }
      if (found.choices?.length) {
        await logHis();
        const question = "Two fit, sir. Which one?";
        await logMessage("tony", question, channel).catch(() => undefined);
        handled.push({ text: part, kind: "choose", question, options: found.choices.map((item) => ({ text: itemLabel(item, clock()).slice(0, 60), data: `lib:send:${item.source}:${item.id}` })) });
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

import { InlineKeyboard } from "grammy";
import { b, esc, expandable } from "./html";
import type { Task } from "./tasks";
import { formatTime, laterThisEvening } from "./time";

/**
 * Button payloads are "action:taskId[:argument]". Taps are handled by code,
 * never by the AI model, so stopping a reminder is instant.
 */
export type Action = "start" | "done" | "skip" | "snooze" | "move" | "tomorrow" | "resched" | "today" | "weekend" | "drop";

export const data = (action: Action, taskId: number, arg?: number) =>
  arg === undefined ? `${action}:${taskId}` : `${action}:${taskId}:${arg}`;

export function parseAction(payload: string): { action: Action; taskId: number; arg?: number } | undefined {
  const [action, taskId, arg] = payload.split(":");
  const known: Action[] = ["start", "done", "skip", "snooze", "move", "tomorrow", "resched", "today", "weekend", "drop"];
  const id = Number(taskId);
  if (!known.includes(action as Action) || !Number.isSafeInteger(id)) return undefined;
  const n = arg === undefined ? undefined : Number(arg);
  if (n !== undefined && !Number.isSafeInteger(n)) return undefined;
  return { action: action as Action, taskId: id, arg: n };
}

export const doneKeyboard = (taskId: number) => new InlineKeyboard().text("Done", data("done", taskId));

export const rescheduleKeyboard = (taskId: number) =>
  new InlineKeyboard().text("In 1 hour", data("snooze", taskId, 60)).text("Tomorrow", data("tomorrow", taskId));

/** A plain, one-time reminder at the due time. Texts here are Telegram HTML. */
/**
 * What a task holds, for its reminder: its notes without links (the link is a button) and without the
 * copy of his message kept "so nothing is lost", folded away under the reminder. "What am I doing
 * today?" is answered by the reminder itself (22 Nov: the IELTS sessions' blocks and the week's types).
 */
export function notesBlock(notes: string | null | undefined, limit = 900): string | undefined {
  const lines = (notes ?? "")
    .split("\n")
    .map((line) => line.replace(/https?:\/\/\S+/g, "").trimEnd())
    .filter((line) => line.trim() && !/^From your message:/.test(line.trim()));
  if (lines.length === 0) return undefined;
  const text = lines.join("\n");
  return expandable(esc(text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text));
}

export function dueReminder(task: Task): { text: string; keyboard: InlineKeyboard } {
  return {
    text: `Sir, a reminder: ${b(task.title)}.`,
    keyboard: new InlineKeyboard()
      .text("Done", data("done", task.id))
      .text("Snooze 15 min", data("snooze", task.id, 15))
      .text("Reschedule", data("resched", task.id)),
  };
}

/**
 * One step of a persistent reminder. `attempt` counts from 0; `nextAt` is
 * when Tony will ask again, or undefined on the closing message.
 */
export function persistentReminder(
  task: Task,
  attempt: number,
  now: Date,
  nextAt: Date | undefined,
  /** Whether a time is free; a "Move to" button is only offered for a free time. */
  isFree: (at: Date) => boolean = () => true,
): { text: string; keyboard?: InlineKeyboard } {
  if (!nextAt) return { text: `I'll leave ${b(task.title)} here for today, sir.` };

  // The three main buttons never change place from one nudge to the next, so
  // a thumb aiming at "15 min" cannot land on something else. The offer to
  // move the task gets a row of its own.
  const keyboard = new InlineKeyboard()
    .text("Starting now", data("start", task.id))
    .text("15 min", data("snooze", task.id, 15))
    .text("Skip today", data("skip", task.id));
  if (attempt === 2) {
    // The first free hour from the usual "later this evening" time; no button if none is free.
    const first = laterThisEvening(now);
    const later = [0, 1, 2, 3].map((hours) => new Date(first.getTime() + hours * 60 * 60_000)).find((at) => at.getDate() === first.getDate() && isFree(at));
    if (later) keyboard.row().text(`Move to ${formatTime(later)}`, data("move", task.id, Math.round(later.getTime() / 60_000)));
  }

  const text =
    attempt === 0
      ? `🔔 Sir, it's time: ${b(task.title)}.`
      : attempt === 1
        ? `A gentle reminder, sir. ${b(task.title)} is still waiting.`
        : attempt === 2
          ? `Sir, shall I move ${b(task.title)} to later today?`
          : `Still nothing logged for ${b(task.title)}, sir. I'll check again at ${b(formatTime(nextAt))}.`;
  return { text, keyboard };
}

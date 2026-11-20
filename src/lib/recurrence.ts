import "server-only";
import { requireDb } from "./db";
import { logHabit } from "./habits";
import { scheduleReminder, settleReminders } from "./reminders";
import { recordDone } from "./routine";
import type { Task } from "./tasks";
import { addMinutes, formatDue, TIMEZONE } from "./time";

const DAY_MINUTES = 24 * 60;

function isWeekday(at: Date, timeZone = TIMEZONE): boolean {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(at);
  return day !== "Sat" && day !== "Sun";
}

/**
 * When a repeating task comes round again: the first occurrence after `now`,
 * at the same time of day. Undefined for a task that does not repeat or has
 * no date to repeat from.
 */
export function nextOccurrence(task: Pick<Task, "due_at" | "repeat_rule">, now: Date): Date | undefined {
  if (!task.repeat_rule || !task.due_at) return undefined;
  const step = task.repeat_rule === "weekly" ? 7 * DAY_MINUTES : DAY_MINUTES;
  let at = new Date(task.due_at);
  // Whole days keep the time of day (Tashkent has no clock changes).
  for (let guard = 0; guard < 5000; guard++) {
    at = addMinutes(at, step);
    if (at.getTime() <= now.getTime()) continue;
    if (task.repeat_rule === "weekdays" && !isWeekday(at)) continue;
    return at;
  }
  return undefined;
}

/**
 * Done or Skip. A one-off task is closed. A repeating task is not closed:
 * it rolls forward to its next date with a fresh reminder, so it is there
 * again tomorrow (or next week) without being re-entered.
 */
export async function finishTask(
  task: Task,
  how: "done" | "skipped",
  now = new Date(),
): Promise<{ next?: Date; nextLabel?: string }> {
  const db = requireDb();
  const next = nextOccurrence(task, now);
  await settleReminders(task.id);
  // A repeating task's occurrence goes into its habit log, for streaks.
  await logHabit(task, how, now);
  // When he really does this kind of task: Tony offers that time first next time.
  if (how === "done") await recordDone(task, now).catch((error) => console.error("recordDone failed:", error));

  if (!next) {
    const patch = how === "done" ? { status: "done", completed_at: now.toISOString() } : { status: "skipped" };
    const { error } = await db.from("tasks").update(patch).eq("id", task.id);
    if (error) throw new Error(`finishTask: ${error.message}`);
    return {};
  }

  const { error } = await db
    .from("tasks")
    .update({ status: "todo", due_at: next.toISOString(), completed_at: how === "done" ? now.toISOString() : task.completed_at })
    .eq("id", task.id);
  if (error) throw new Error(`finishTask: ${error.message}`);
  await scheduleReminder(task.id, next);
  return { next, nextLabel: formatDue(next, now) };
}

import type { Task } from "./tasks";
import { dayBounds } from "./time";

/**
 * What "today" holds, worked out one way for everything that shows it: the
 * pinned board in Telegram and the app's Today view. Given every task that
 * could matter (open ones, and ones finished recently), it returns:
 * - carried: open, due before today began (overdue from earlier days);
 * - timed: open, due today (earlier today included, even if past);
 * - done: finished today. A repeating task ticked off today has already
 *   rolled to its next date, so it is recognised by when it was completed.
 * total = carried + timed + done, so "2/11 done" means the same everywhere.
 */
export type TodaySplit = { carried: Task[]; timed: Task[]; done: Task[]; total: number };

const OPEN = new Set(["inbox", "todo", "in_progress"]);

export function splitToday(tasks: Task[], day: Date): TodaySplit {
  const { start, end } = dayBounds(day);
  const at = (value: string) => new Date(value).getTime();
  const finishedToday = (task: Task) => task.completed_at !== null && at(task.completed_at) >= start.getTime() && at(task.completed_at) < end.getTime();
  const done = tasks.filter((task) => finishedToday(task) && (task.status === "done" || (task.due_at !== null && at(task.due_at) >= end.getTime())));
  const doneIds = new Set(done.map((task) => task.id));
  const open = tasks.filter((task) => OPEN.has(task.status) && task.due_at !== null && at(task.due_at) < end.getTime() && !doneIds.has(task.id));
  const byDue = (a: Task, b: Task) => at(a.due_at!) - at(b.due_at!);
  const carried = open.filter((task) => at(task.due_at!) < start.getTime()).sort(byDue);
  const timed = open.filter((task) => at(task.due_at!) >= start.getTime()).sort(byDue);
  return { carried, timed, done, total: carried.length + timed.length + done.length };
}

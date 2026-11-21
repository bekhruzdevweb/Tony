import "server-only";
import { requireDb } from "./db";
import { scheduleReminder, settleReminders } from "./reminders";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, hisTomorrow, localDate, parseLocalDateTime, toWholeMinute } from "./time";

/**
 * "Reschedule" on the Overdue section: every overdue task moves to today or
 * tomorrow at its own time of day. If that time has already passed today,
 * it goes to the next whole hour instead. Plain code, no AI.
 */
export async function rescheduleOverdue(to: "today" | "tomorrow", now = new Date()): Promise<number> {
  const db = requireDb();
  const { data, error } = await db.from("tasks").select().in("status", OPEN_STATUSES).neq("status", "in_progress").or("kind.is.null,kind.neq.prayer").lt("due_at", now.toISOString());
  if (error) throw new Error(`rescheduleOverdue: ${error.message}`);
  // After midnight, "tomorrow" is the day just begun (the day after he sleeps).
  const day = localDate(to === "today" ? now : hisTomorrow(now));
  const nextHour = toWholeMinute(addMinutes(now, 60 - (now.getMinutes() % 60)));
  let moved = 0;
  for (const task of (data ?? []) as Task[]) {
    let at = parseLocalDateTime(`${day}T${formatTime(new Date(task.due_at!))}`)!;
    if (at.getTime() <= now.getTime()) at = nextHour.getTime() < dayBounds(now).end.getTime() ? nextHour : at;
    await settleReminders(task.id);
    const update = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo" }).eq("id", task.id);
    if (update.error) throw new Error(`rescheduleOverdue: ${update.error.message}`);
    await scheduleReminder(task.id, at);
    moved++;
  }
  return moved;
}

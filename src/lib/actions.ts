import "server-only";
import type { InlineKeyboard } from "grammy";
import { requireDb } from "./db";
import { doneKeyboard, rescheduleKeyboard, type Action } from "./reminder-messages";
import { scheduleReminder, settleReminders } from "./reminders";
import { OPEN_STATUSES, type Task } from "./tasks";
import { b } from "./html";
import { finishTask } from "./recurrence";
import { addMinutes, dayBounds, formatTime, localDate, minuteOfDay, parseLocalDateTime, TIMEZONE, toWholeMinute } from "./time";

const weekdayOf = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" }).format(at);

export type ActionOutcome = {
  /** What Tony says back, as Telegram HTML; nothing when the tap only changes the buttons. */
  text?: string;
  /** New buttons for the tapped message; null removes them. */
  keyboard: InlineKeyboard | null;
};

async function updateTask(id: number, patch: Partial<Task>): Promise<void> {
  const { error } = await requireDb().from("tasks").update(patch).eq("id", id);
  if (error) throw new Error(`updateTask: ${error.message}`);
}

/** A button tap. Plain code, no AI model. */
export async function runAction(action: Action, taskId: number, arg: number | undefined, now = new Date()): Promise<ActionOutcome> {
  const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
  if (found.error) throw new Error(`runAction: ${found.error.message}`);
  const task = found.data as Task | null;
  if (!task) return { text: "That task no longer exists, sir.", keyboard: null };
  if (!OPEN_STATUSES.includes(task.status)) {
    return { text: `${b(task.title)} is already settled, sir.`, keyboard: null };
  }

  switch (action) {
    case "start":
      await updateTask(task.id, { status: "in_progress" });
      await settleReminders(task.id);
      return { text: "Excellent. Enjoy it, sir.", keyboard: doneKeyboard(task.id) };

    case "done": {
      const { nextLabel } = await finishTask(task, "done", now);
      return {
        text: nextLabel ? `✓ Done, sir. ${b(task.title)} comes round again ${b(nextLabel)}.` : `✓ Done, sir. ${b(task.title)} is off the list.`,
        keyboard: null,
      };
    }

    case "skip": {
      const { nextLabel } = await finishTask(task, "skipped", now);
      return { text: nextLabel ? `Skipped, sir. Next one ${b(nextLabel)}.` : "Skipped for today, sir.", keyboard: null };
    }

    case "drop":
      await updateTask(task.id, { status: "dropped" });
      await settleReminders(task.id);
      return { text: `Dropped, sir. ${b(task.title)} is off the list.`, keyboard: null };

    // "Put it on today": at its usual time if that is still ahead today,
    // otherwise the next full hour that is at least half an hour away.
    case "today": {
      const { start, end } = dayBounds(now);
      const hour = 60 * 60_000;
      let at = new Date(Math.ceil((now.getTime() + hour / 2) / hour) * hour);
      // Late in the evening that hour is already tomorrow; then simply soon.
      if (at.getTime() >= end.getTime()) at = toWholeMinute(addMinutes(now, 15));
      if (task.due_at) {
        const usual = new Date(start.getTime() + minuteOfDay(new Date(task.due_at)) * 60_000);
        if (usual.getTime() > now.getTime()) at = usual;
      }
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      return { text: `On today's list at ${b(formatTime(at))}, sir.`, keyboard: null };
    }

    // Saturday at 10:00 (the coming one).
    case "weekend": {
      let at = parseLocalDateTime(`${localDate(now)}T10:00`)!;
      for (let i = 0; i < 8 && (weekdayOf(at) !== "Sat" || at.getTime() <= now.getTime()); i++) at = addMinutes(at, 24 * 60);
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      return { text: `Set for ${b(`Saturday at ${formatTime(at)}`)}, sir.`, keyboard: null };
    }

    case "snooze": {
      const at = toWholeMinute(addMinutes(now, arg ?? 15));
      await scheduleReminder(task.id, at);
      return { text: `Very good, sir. I'll ask again at ${b(formatTime(at))}.`, keyboard: null };
    }

    case "move": {
      const at = arg === undefined ? toWholeMinute(addMinutes(now, 60)) : new Date(arg * 60_000);
      if (at.getTime() <= now.getTime()) {
        return { text: "That time has already passed, sir.", keyboard: null };
      }
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      return { text: `Moved to ${b(formatTime(at))}, sir.`, keyboard: null };
    }

    case "tomorrow": {
      // Tomorrow's date, at the task's own time of day (09:00 for an undated task).
      const time = task.due_at ? formatTime(new Date(task.due_at)) : "09:00";
      const at = parseLocalDateTime(`${localDate(addMinutes(now, 24 * 60))}T${time}`)!;
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      return { text: `Moved to ${b(`tomorrow at ${formatTime(at)}`)}, sir.`, keyboard: null };
    }

    case "resched":
      return { keyboard: rescheduleKeyboard(task.id) };
  }
}

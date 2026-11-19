import "server-only";
import type { InlineKeyboard } from "grammy";
import { requireDb } from "./db";
import { doneKeyboard, rescheduleKeyboard, type Action } from "./reminder-messages";
import { scheduleReminder, settleReminders } from "./reminders";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, formatTime } from "./time";

export type ActionOutcome = {
  /** What Tony says back; nothing when the tap only changes the buttons. */
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
    return { text: `"${task.title}" is already settled, sir.`, keyboard: null };
  }

  switch (action) {
    case "start":
      await updateTask(task.id, { status: "in_progress" });
      await settleReminders(task.id);
      return { text: "Excellent. Enjoy it, sir.", keyboard: doneKeyboard(task.id) };

    case "done":
      await updateTask(task.id, { status: "done", completed_at: now.toISOString() });
      await settleReminders(task.id);
      return { text: `Done, sir. "${task.title}" is off the list.`, keyboard: null };

    case "skip":
      await updateTask(task.id, { status: "skipped" });
      await settleReminders(task.id);
      return { text: `Skipped for today, sir.`, keyboard: null };

    case "snooze": {
      const at = addMinutes(now, arg ?? 15);
      await scheduleReminder(task.id, at);
      return { text: `Very good, sir. I'll ask again at ${formatTime(at)}.`, keyboard: null };
    }

    case "move": {
      const at = arg === undefined ? addMinutes(now, 60) : new Date(arg * 60_000);
      if (at.getTime() <= now.getTime()) {
        return { text: "That time has already passed, sir.", keyboard: null };
      }
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      return { text: `Moved to ${formatTime(at)}, sir.`, keyboard: null };
    }

    case "tomorrow": {
      let at = addMinutes(task.due_at ? new Date(task.due_at) : now, 24 * 60);
      while (at.getTime() <= now.getTime()) at = addMinutes(at, 24 * 60);
      await updateTask(task.id, { due_at: at.toISOString(), status: "todo" });
      await scheduleReminder(task.id, at);
      return { text: `Moved to tomorrow at ${formatTime(at)}, sir.`, keyboard: null };
    }

    case "resched":
      return { keyboard: rescheduleKeyboard(task.id) };
  }
}

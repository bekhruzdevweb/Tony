import "server-only";
import type { Bot } from "grammy";
import { requireDb } from "./db";
import { env } from "./env";
import { retire, sendHtml, track } from "./chat-log";
import { plain } from "./html";
import { logMessage } from "./messages";
import { sayAloud } from "./speech";
import { dueReminder, persistentReminder } from "./reminder-messages";
import { getSettings, updateSettings, type Settings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, inWindow, toWholeMinute } from "./time";

export type Reminder = {
  id: number;
  task_id: number | null;
  fire_at: string;
  kind: "due" | "nudge" | "stale" | "brief" | "extra";
  attempt: number;
  state: "scheduled" | "sent" | "acknowledged" | "cancelled";
  telegram_message_id: number | null;
  sent_at: string | null;
  claimed_at: string | null;
};

/** Spec: at most 6 unprompted messages per hour in total. */
export const HOURLY_MESSAGE_CAP = 6;
const BATCH = 20;
/** How long a tick may hold a reminder while sending it. */
const LEASE_MINUTES = 2;
/** Stop starting new sends after this long, so the tick ends well inside its time limit. */
const TICK_BUDGET_MS = 18_000;

function fail(where: string, error: { message: string } | null) {
  if (error) throw new Error(`${where}: ${error.message}`);
}

/** Stop everything pending for a task: the user has answered. */
export async function settleReminders(taskId: number): Promise<void> {
  const db = requireDb();
  const cancelled = await db.from("reminders").update({ state: "cancelled" }).eq("task_id", taskId).eq("state", "scheduled");
  fail("settleReminders", cancelled.error);
  const acknowledged = await db.from("reminders").update({ state: "acknowledged" }).eq("task_id", taskId).eq("state", "sent");
  fail("settleReminders", acknowledged.error);
  // The question is answered, so the messages that asked it can be tidied
  // away. (A message just tapped is given a new fate by its handler.)
  await retire({ kinds: ["reminder", "prompt", "stale"], taskId });
}

/** Replace whatever is pending for the task with a fresh reminder at `at`. */
export async function scheduleReminder(taskId: number, at: Date): Promise<void> {
  await settleReminders(taskId);
  const { error } = await requireDb()
    .from("reminders")
    .insert({ task_id: taskId, fire_at: toWholeMinute(at).toISOString(), kind: "due", attempt: 0 });
  fail("scheduleReminder", error);
}

/** A dated task, with its reminder. */
export async function addScheduledTask(input: {
  title: string;
  dueAt: Date;
  persistent?: boolean;
  schedule?: number[];
}): Promise<Task> {
  const dueAt = toWholeMinute(input.dueAt);
  const { data, error } = await requireDb()
    .from("tasks")
    .insert({
      title: input.title,
      status: "todo",
      due_at: dueAt.toISOString(),
      persistent: input.persistent ?? false,
      persistent_schedule: input.schedule ?? null,
    })
    .select()
    .single();
  fail("addScheduledTask", error);
  const task = data as Task;
  await scheduleReminder(task.id, dueAt);
  return task;
}

/**
 * The steps of a persistent reminder, in minutes after its first message,
 * followed by one closing step a little after the last nudge.
 */
function chainOffsets(task: Task, settings: Settings): number[] {
  const steps = [...(task.persistent_schedule ?? settings.persistent_schedule)].sort((a, b) => a - b);
  if (steps.length === 0 || steps[0] !== 0) steps.unshift(0);
  const last = steps[steps.length - 1];
  const gap = steps.length > 1 ? last - steps[steps.length - 2] : 15;
  return [...steps, last + gap];
}

export type TickResult = {
  sent: number;
  deferred: number;
  cancelled: number;
  failed: number;
  skipped?: string;
};

/**
 * Called once a minute. Sends every reminder that has come due, subject to
 * quiet hours and the anti-spam caps, and queues the next step of each
 * persistent reminder.
 */
export async function runTick(
  bot: Bot,
  chatId: number,
  now = new Date(),
  // Passed in by the tick route; kept out of this file so briefs can use the button actions.
  options: { briefs?: (settings: Settings, now: Date) => Promise<unknown> } = {},
): Promise<TickResult> {
  const db = requireDb();
  const result: TickResult = { sent: 0, deferred: 0, cancelled: 0, failed: 0 };
  const settings = await getSettings();
  const started = Date.now();
  // Recorded only when a tick ends cleanly: the database's retry job calls
  // again at :20 and :40 for any minute that has no clean tick.
  const finish = async () => {
    if (result.failed === 0) await updateSettings({ last_tick_at: now.toISOString() });
    return result;
  };

  // Briefs first. A fault here must not hold up the reminders below.
  if (options.briefs) {
    try {
      await options.briefs(settings, now);
    } catch (error) {
      console.error("Briefs failed:", error);
      result.failed++;
    }
  }

  // Free to send: no lease, or a lease so old that the tick holding it must have died.
  const free = `claimed_at.is.null,claimed_at.lt.${addMinutes(now, -LEASE_MINUTES).toISOString()}`;

  const due = await db
    .from("reminders")
    .select("*, task:tasks(*)")
    .eq("state", "scheduled")
    .lte("fire_at", now.toISOString())
    .or(free)
    .order("fire_at", { ascending: true })
    .limit(BATCH);
  fail("runTick: due", due.error);
  const reminders = (due.data ?? []) as (Reminder & { task: Task | null })[];
  if (reminders.length === 0) return finish();

  const recent = await db
    .from("reminders")
    .select("id", { count: "exact", head: true })
    .gte("sent_at", addMinutes(now, -60).toISOString());
  fail("runTick: recent", recent.error);
  let sentThisHour = recent.count ?? 0;

  const quiet = (at: Date) => inWindow(at, settings.quiet_start, settings.quiet_end, settings.timezone);

  const cancel = async (id: number) => {
    const { error } = await db.from("reminders").update({ state: "cancelled" }).eq("id", id).eq("state", "scheduled");
    fail("runTick: cancel", error);
    result.cancelled++;
  };

  for (const reminder of reminders) {
    if (Date.now() - started > TICK_BUDGET_MS) {
      // Out of time: whatever is left stays scheduled for the next call.
      result.failed++;
      break;
    }
    const task = reminder.task;
    if (!task || !OPEN_STATUSES.includes(task.status)) {
      await cancel(reminder.id);
      continue;
    }

    // An extra reminder (set_reminder) is a single message, never a chain.
    const chained = task.persistent && reminder.kind !== "extra";
    const offsets = chained ? chainOffsets(task, settings) : [0];
    const attempt = Math.min(reminder.attempt, offsets.length - 1);
    const isFollowUp = reminder.attempt > 0 || (reminder.kind !== "due" && reminder.kind !== "extra");
    // The moment this persistent reminder began, so later steps keep their
    // planned times even when a message goes out a minute late.
    const base = addMinutes(new Date(reminder.fire_at), -offsets[attempt]);
    const nextAt = chained && attempt + 1 < offsets.length ? addMinutes(base, offsets[attempt + 1]) : undefined;

    const queueNext = async () => {
      if (!nextAt) return;
      const { error } = await db
        .from("reminders")
        .insert({ task_id: task.id, fire_at: nextAt.toISOString(), kind: "nudge", attempt: attempt + 1 });
      fail("runTick: next step", error);
    };

    // Quiet hours: Tony does not follow up at night, unless the task itself
    // was set for the night. The task stays open and overdue, so it is
    // picked up in the morning.
    if (isFollowUp && quiet(now) && !(task.due_at && quiet(new Date(task.due_at)))) {
      await cancel(reminder.id);
      continue;
    }

    // At most one non-persistent nudge per task per day.
    if (!task.persistent && isFollowUp) {
      const today = await db
        .from("reminders")
        .select("id", { count: "exact", head: true })
        .eq("task_id", task.id)
        .in("kind", ["nudge", "stale"])
        .gte("sent_at", dayBounds(now, settings.timezone).start.toISOString());
      fail("runTick: daily cap", today.error);
      if ((today.count ?? 0) > 0) {
        await cancel(reminder.id);
        continue;
      }
    }

    // Hourly cap. A first reminder waits for room; a follow-up is dropped
    // and the persistent reminder simply moves on to its next step.
    if (sentThisHour >= HOURLY_MESSAGE_CAP) {
      if (isFollowUp) {
        await cancel(reminder.id);
        await queueNext();
      } else {
        result.deferred++;
      }
      continue;
    }

    // Take a lease, so two overlapping ticks cannot both send it. The
    // reminder stays 'scheduled' until Telegram confirms delivery.
    const claimed = await db
      .from("reminders")
      .update({ claimed_at: now.toISOString() })
      .eq("id", reminder.id)
      .eq("state", "scheduled")
      .or(free)
      .select("id");
    fail("runTick: claim", claimed.error);
    if ((claimed.data ?? []).length === 0) continue;

    const message = chained ? persistentReminder(task, attempt, now, nextAt) : dueReminder(task);
    let messageId: number | undefined;
    // Two tries, each with a hard timeout: a stalled connection must never
    // hold the tick until the platform kills it.
    for (let tryNumber = 1; tryNumber <= 2 && messageId === undefined; tryNumber++) {
      try {
        messageId = await sendHtml(bot, chatId, message.text, {
          keyboard: message.keyboard,
          // A follow-up on an ordinary, low-priority task arrives without sound.
          silent: isFollowUp && !task.persistent && task.priority === 4,
        });
      } catch (error) {
        console.error(`Reminder ${reminder.id}: send attempt ${tryNumber} failed:`, error);
      }
    }

    if (messageId === undefined) {
      // Give the lease back; the next call (20 seconds away at most) tries again.
      await db.from("reminders").update({ claimed_at: null }).eq("id", reminder.id).eq("state", "scheduled");
      result.failed++;
      continue;
    }

    // Telegram has confirmed delivery: only now is it 'sent'.
    const saved = await db
      .from("reminders")
      .update({ state: "sent", sent_at: new Date().toISOString(), telegram_message_id: messageId, claimed_at: null })
      .eq("id", reminder.id);
    fail("runTick: mark sent", saved.error);
    await logMessage("tony", plain(message.text));
    // Tracked, so it is removed once the task is done, skipped or moved.
    await track(messageId, "reminder", { taskId: task.id });
    // With TTS_SPEAK=all, a persistent reminder also speaks from its third
    // nudge on, more firmly. Only when there is time left in this tick.
    if (env.ttsSpeakAll && chained && attempt >= 2 && nextAt && Date.now() - started < TICK_BUDGET_MS / 2) {
      const voiceId = await sayAloud(bot, chatId, plain(message.text), "nudge", { now, nudgeNumber: attempt + 1 });
      if (voiceId !== undefined) await track(voiceId, "reminder", { taskId: task.id });
    }

    sentThisHour++;
    result.sent++;
    await queueNext();
  }

  return finish();
}

/** The task a reminder message was about, for when he replies to that message. */
export async function taskForReminderMessage(messageId: number): Promise<Task | undefined> {
  const { data, error } = await requireDb()
    .from("reminders")
    .select("task:tasks(*)")
    .eq("telegram_message_id", messageId)
    .order("id", { ascending: false })
    .limit(1);
  fail("taskForReminderMessage", error);
  const row = (data ?? [])[0] as { task: Task | Task[] | null } | undefined;
  const task = Array.isArray(row?.task) ? row.task[0] : row?.task;
  return task ?? undefined;
}

/** Recent reminder messages for a task, other than the one just tapped. */
export async function otherReminderMessages(taskId: number, except?: number): Promise<number[]> {
  const { data, error } = await requireDb()
    .from("reminders")
    .select("telegram_message_id")
    .eq("task_id", taskId)
    .in("state", ["sent", "acknowledged"])
    .order("id", { ascending: false })
    .limit(8);
  fail("otherReminderMessages", error);
  return ((data ?? []) as { telegram_message_id: number | null }[])
    .filter((row) => row.telegram_message_id !== null)
    .map((row) => Number(row.telegram_message_id))
    .filter((id) => id !== except);
}

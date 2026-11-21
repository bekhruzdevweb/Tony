import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { requireDb } from "./db";
import { retire, sendHtml, track } from "./chat-log";
import { b, esc, i, plain } from "./html";
import { mediaForTask, sendMedia } from "./media";
import { logMessage } from "./messages";
import { sayAloud } from "./speech";
import { busyAround, getRoutine } from "./routine";
import { checkInDue, checkInTime } from "./routine-rules";
import { estimateMinutes } from "./schedule";
import { progress, subtasksFor } from "./subtasks";
import { data, dueReminder, persistentReminder } from "./reminder-messages";
import { openButton } from "./link-rules";
import { getSettings, updateSettings, type Settings } from "./settings";
import { isPrayer, OPEN_STATUSES, type Task } from "./tasks";
import { downtime, MERGE_MS, mergeable } from "./smart-rules";
import { logEvent } from "./events";
import { addMinutes, dayBounds, formatTime, inWindow, toWholeMinute } from "./time";

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
  /** A check-in ("remind me if I don't check it for N days"): N. */
  every_days?: number | null;
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
  let reminders = (due.data ?? []) as (Reminder & { task: Task | null })[];
  if (reminders.length === 0) return finish();

  // After downtime (phase e): what came due while Tony was away goes out as ONE catch-up message, not a flood.
  const away = downtime(settings.last_tick_at, now);
  if (away && !inWindow(now, settings.quiet_start, settings.quiet_end, settings.timezone)) {
    const missed = reminders.filter((reminder) => reminder.task && OPEN_STATUSES.includes(reminder.task.status) && !isPrayer(reminder.task) && reminder.kind !== "stale" && new Date(reminder.fire_at).getTime() >= away.from.getTime() && new Date(reminder.fire_at).getTime() <= now.getTime() - 5 * 60_000);
    const tasks = [...new Map(missed.map((reminder) => [reminder.task!.id, reminder.task!])).values()];
    if (tasks.length >= 2) {
      const lines = tasks.slice(0, 8).map((task, index) => `${index + 1}. ${b(task.title)}${task.due_at ? ` (${formatTime(new Date(task.due_at))})` : ""}`);
      const keyboard = new InlineKeyboard();
      tasks.slice(0, 8).forEach((task, index) => {
        if (index > 0) keyboard.row();
        keyboard.text(`✓ ${index + 1}`, `fu:done:${task.id}`).text(`⏰ ${index + 1}`, `fu:later:${task.id}`).text(`📅 ${index + 1}`, `fu:tom:${task.id}`);
      });
      const text = `I was offline from ${b(formatTime(away.from))} to ${b(formatTime(now))}, sir. Missed meanwhile:\n${lines.join("\n")}`;
      const messageId = await sendHtml(bot, chatId, text, { keyboard }).catch(() => undefined);
      if (messageId !== undefined) {
        for (const reminder of missed) {
          await db.from("reminders").update({ state: "sent", sent_at: new Date().toISOString(), telegram_message_id: messageId, claimed_at: null }).eq("id", reminder.id).eq("state", "scheduled");
        }
        await track(messageId, "reminder");
        await logMessage("tony", plain(text));
        await logEvent("catch_up", { from: away.from.toISOString(), minutes: away.minutes, tasks: tasks.map((task) => task.id) });
        result.sent++;
        reminders = reminders.filter((reminder) => !missed.includes(reminder));
      }
    }
  }

  // Reminders within 15 minutes of each other go out as ONE message (phase e): plain first reminders, not prayers or persistent chains.
  const plainFirst = (reminder: Reminder & { task: Task | null }) => reminder.kind === "due" && reminder.attempt === 0 && reminder.task && !reminder.task.persistent && !isPrayer(reminder.task) && OPEN_STATUSES.includes(reminder.task.status);
  const lead = reminders.find(plainFirst);
  if (lead && !inWindow(now, settings.quiet_start, settings.quiet_end, settings.timezone)) {
    const soon = await db
      .from("reminders")
      .select("*, task:tasks(*)")
      .eq("state", "scheduled")
      .eq("kind", "due")
      .eq("attempt", 0)
      .lte("fire_at", new Date(new Date(lead.fire_at).getTime() + MERGE_MS).toISOString())
      .order("fire_at", { ascending: true })
      .limit(10);
    const together = [lead, ...mergeable(lead, ((soon.data ?? []) as (Reminder & { task: Task | null })[]).filter(plainFirst).filter((other) => other.id !== lead.id))];
    if (together.length >= 2) {
      const lines = together.map((reminder, index) => `${index + 1}. ${b(formatTime(new Date(reminder.task!.due_at ?? reminder.fire_at)))} ${b(reminder.task!.title)}`);
      const keyboard = new InlineKeyboard();
      together.forEach((reminder, index) => {
        if (index > 0) keyboard.row();
        keyboard.text(`✓ ${index + 1}`, `fu:done:${reminder.task!.id}`).text(`⏰ 15m ${index + 1}`, `fu:snooze:${reminder.task!.id}`).text(`📅 ${index + 1}`, `fu:tom:${reminder.task!.id}`);
      });
      const text = `Sir, ${together.length} reminders together:\n${lines.join("\n")}`;
      const messageId = await sendHtml(bot, chatId, text, { keyboard }).catch(() => undefined);
      if (messageId !== undefined) {
        for (const reminder of together) {
          await db.from("reminders").update({ state: "sent", sent_at: new Date().toISOString(), telegram_message_id: messageId, claimed_at: null }).eq("id", reminder.id).eq("state", "scheduled");
          await track(messageId, "reminder", { taskId: reminder.task!.id });
        }
        await logMessage("tony", plain(text));
        result.sent++;
        const ids = new Set(together.map((reminder) => reminder.id));
        reminders = reminders.filter((reminder) => !ids.has(reminder.id));
      }
    }
  }

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

    // A check-in ("remind me if I don't check it for N days") goes out only if the task really sat
    // untouched that long; if he touched it, it waits N days from then. At night it waits for the morning.
    const checkIn = reminder.kind === "stale";
    if (checkIn) {
      const routine = await getRoutine();
      const everyDays = reminder.every_days ?? 0;
      const due = everyDays > 0 ? checkInDue({ now, updatedAt: new Date(task.updated_at), everyDays, routine }) : ({ send: true } as const);
      const later = !due.send ? due.next : quiet(now) ? checkInTime(now, 0, routine) : undefined;
      if (later && later.getTime() > now.getTime()) {
        const moved = await db.from("reminders").update({ fire_at: later.toISOString(), claimed_at: null }).eq("id", reminder.id).eq("state", "scheduled");
        fail("runTick: check-in", moved.error);
        result.deferred++;
        continue;
      }
    }

    // An extra reminder (set_reminder) and a check-in are single messages, never a chain.
    const chained = task.persistent && reminder.kind !== "extra" && !checkIn;
    const offsets = chained ? chainOffsets(task, settings) : [0];
    const attempt = Math.min(reminder.attempt, offsets.length - 1);
    // A check-in is not a follow-up: it is never dropped for quiet hours or the daily cap, only delayed.
    const isFollowUp = reminder.attempt > 0 || (reminder.kind !== "due" && reminder.kind !== "extra" && !checkIn);
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

    // A prayer: a calm line and one button, a heads-up 10 minutes before (silent) and one at the time.
    const prayer = isPrayer(task);
    // A "Move to" offer is only made for a time that is actually free.
    const isFree = chained && attempt === 2 ? await freeTimes(task) : undefined;
    const message = prayer
      ? prayerReminder(task, reminder.kind === "extra")
      : checkIn
        ? checkInMessage(task, reminder.every_days ?? Math.max(1, Math.round((now.getTime() - new Date(task.updated_at).getTime()) / (24 * 60 * 60_000))))
        : chained
          ? persistentReminder(task, attempt, now, nextAt, isFree)
          : dueReminder(task);
    // A task with a link (a reel to watch): the link itself as a button, so he never has to ask for it.
    const open = prayer ? undefined : openButton(task.notes);
    if (open) message.keyboard = (message.keyboard ?? new InlineKeyboard()).row().url(open.text, open.url);
    // A task with parts: "Post stories 1/3" and the parts still to do.
    if (!prayer) {
      const list = (await subtasksFor([task.id])).get(task.id) ?? [];
      if (list.length) message.text = `${message.text}\n${i(`${progress(list)} done`)}\n${list.map((s) => `${s.done ? "☑" : "☐"} ${esc(s.title)}`).join("\n")}`;
    }
    // Only the first reminder carries the attachment; later nudges are plain text.
    const attached = attempt === 0 ? await mediaForTask(task.id).catch(() => undefined) : undefined;
    let messageId: number | undefined;
    // Two tries, each with a hard timeout: a stalled connection must never
    // hold the tick until the platform kills it.
    for (let tryNumber = 1; tryNumber <= 2 && messageId === undefined; tryNumber++) {
      try {
        const options = {
          keyboard: message.keyboard,
          // A follow-up on an ordinary, low-priority task arrives without sound.
          silent: (prayer && reminder.kind === "extra") || (isFollowUp && !task.persistent && task.priority === 4),
        };
        // If he attached a photo or file to this task, the reminder is the original itself, with his note.
        messageId = attached
          ? await sendMedia(bot, chatId, attached, attached.note || attached.caption ? `${message.text}\n${i(attached.note ?? attached.caption ?? "")}` : message.text, options)
          : await sendHtml(bot, chatId, message.text, options);
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
    await track(messageId, checkIn ? "stale" : "reminder", { taskId: task.id });
    // A prayer at its time: the "in 10 minutes" heads-up has done its job and goes, one message per prayer.
    if (prayer && reminder.kind !== "extra") {
      for (const old of await otherReminderMessages(task.id, messageId).catch(() => [] as number[])) await bot.api.deleteMessage(chatId, old).catch(() => undefined);
    }
    // The next check-in, N days on, for as long as the task sits untouched.
    if (checkIn && (reminder.every_days ?? 0) > 0) {
      const next = checkInTime(now, reminder.every_days!, await getRoutine());
      const queued = await db.from("reminders").insert({ task_id: task.id, fire_at: next.toISOString(), kind: "stale", attempt: 0, every_days: reminder.every_days });
      fail("runTick: next check-in", queued.error);
    }
    // The final call: two nudges of a persistent reminder went unanswered, so the third is also said aloud
    // (within the day's voice limit, and only while this tick has time to spare).
    if (chained && attempt === 2 && Date.now() - started < TICK_BUDGET_MS / 2) {
      const due = task.due_at ? ` It was due at ${formatTime(new Date(task.due_at))}.` : "";
      const voiceId = await sayAloud(bot, chatId, `Final call, sir: ${task.title}.${due} A tap on the reminder settles it.`, "final", { now });
      if (voiceId !== undefined) await track(voiceId, "reminder", { taskId: task.id });
    }
    sentThisHour++;
    result.sent++;
    await queueNext();
  }

  return finish();
}

/** A check for free times against the open, timed tasks (other than this one). */
async function freeTimes(task: Task): Promise<(at: Date) => boolean> {
  // Free for the task's whole length, ten minutes clear of anything else (prayers ±15 minutes).
  const busy = await busyAround(new Date(), [task.id]).catch(() => []);
  const length = (task.duration_minutes || estimateMinutes(task.title)) * 60_000;
  const gap = 10 * 60_000;
  return (at: Date) => busy.every((other) => at.getTime() + length + gap <= other.start || at.getTime() >= other.end + gap);
}

/** A check-in: the task has sat untouched; [✓ Done] [Tomorrow] [Drop]. */
function checkInMessage(task: Task, days: number): { text: string; keyboard?: InlineKeyboard } {
  return {
    text: `📥 Sir, ${b(task.title)} has sat untouched for ${days} ${days === 1 ? "day" : "days"}.`,
    keyboard: new InlineKeyboard().text("✓ Done", data("done", task.id)).text("Tomorrow", data("tomorrow", task.id)).text("Drop", data("drop", task.id)),
  };
}

/** A prayer's reminder: "🕌 Asr in 10 minutes · 15:20", then "🕌 Asr · 15:20" with [✓ Prayed]. */
function prayerReminder(task: Task, early: boolean): { text: string; keyboard?: InlineKeyboard } {
  // A time from the fallback (not the official table) says so.
  const at = `${formatTime(new Date(task.due_at!))}${task.notes === "approx." ? " (approx.)" : ""}`;
  return early
    ? { text: `🕌 ${esc(task.title)} in 10 minutes · ${at}` }
    : { text: `🕌 ${esc(task.title)} · ${at}`, keyboard: new InlineKeyboard().text("Prayed ✓", `done:${task.id}`) };
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

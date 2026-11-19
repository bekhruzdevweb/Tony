import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { retire, sendHtml, track } from "./chat-log";
import { requireDb } from "./db";
import { env } from "./env";
import { b, esc, plain } from "./html";
import { logMessage } from "./messages";
import { suggestSlot } from "./planner";
import { data } from "./reminder-messages";
import { HOURLY_MESSAGE_CAP } from "./reminders";
import type { Settings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, inWindow, minuteOfDay } from "./time";

/**
 * Tony's unprompted suggestions. When a task is overdue, or the next hour
 * or two is free and something waits in the inbox, he proposes one concrete
 * slot himself ("You are free after the club. Reading at 21:00?") with
 * buttons. At most three a day, never two within two hours, never at night.
 */
export const MAX_SUGGESTIONS_PER_DAY = 3;
const MIN_GAP_MINUTES = 120;
/** How long a task must be overdue before Tony raises it (its own reminders come first). */
const OVERDUE_MINUTES = 45;
const MINUTE = 60_000;

const sentence = (text: string) => text[0].toUpperCase() + text.slice(1);

export async function runSuggestions(bot: Bot, chatId: number, settings: Settings, now = new Date()): Promise<number> {
  // Looked at every quarter of an hour, which is often enough and keeps the minute tick light.
  if (!env.suggestEveryTick && minuteOfDay(now, settings.timezone) % 15 !== 0) return 0;
  if (inWindow(now, settings.quiet_start, settings.quiet_end, settings.timezone)) return 0;
  const db = requireDb();
  const { start } = dayBounds(now, settings.timezone);

  const [today, lastHour] = await Promise.all([
    db.from("reminders").select("task_id, sent_at").eq("kind", "suggest").gte("sent_at", start.toISOString()),
    db.from("reminders").select("id", { count: "exact", head: true }).gte("sent_at", addMinutes(now, -60).toISOString()),
  ]);
  if (today.error || lastHour.error) throw new Error(`runSuggestions: ${(today.error ?? lastHour.error)!.message}`);
  const made = (today.data ?? []) as { task_id: number | null; sent_at: string }[];
  if (made.length >= MAX_SUGGESTIONS_PER_DAY) return 0;
  if (made.some((row) => now.getTime() - new Date(row.sent_at).getTime() < MIN_GAP_MINUTES * MINUTE)) return 0;
  if ((lastHour.count ?? 0) >= HOURLY_MESSAGE_CAP - 1) return 0;

  const [taskRows, pendingRows] = await Promise.all([
    db.from("tasks").select().in("status", OPEN_STATUSES).limit(500),
    db.from("reminders").select("task_id").eq("state", "scheduled"),
  ]);
  if (taskRows.error || pendingRows.error) throw new Error(`runSuggestions: ${(taskRows.error ?? pendingRows.error)!.message}`);
  const tasks = taskRows.data as Task[];
  const hasReminder = new Set(((pendingRows.data ?? []) as { task_id: number | null }[]).map((row) => Number(row.task_id)));
  const suggested = new Set(made.map((row) => Number(row.task_id)));
  const fresh = (task: Task) => !suggested.has(task.id) && task.status !== "in_progress";

  // First choice: something overdue whose own reminders have run their course.
  const overdue = tasks
    .filter((task) => fresh(task) && task.due_at && now.getTime() - new Date(task.due_at).getTime() > OVERDUE_MINUTES * MINUTE && !hasReminder.has(task.id))
    .sort((x, y) => x.priority - y.priority || x.due_at!.localeCompare(y.due_at!))[0];
  // Otherwise, once a day, the oldest inbox item, if the coming hours are free.
  const gapUsed = made.some((row) => tasks.find((task) => task.id === Number(row.task_id))?.status === "inbox");
  const inbox = overdue || gapUsed ? undefined : tasks.filter((task) => fresh(task) && task.status === "inbox").sort((x, y) => x.priority - y.priority || x.created_at.localeCompare(y.created_at))[0];
  const task = overdue ?? inbox;
  if (!task) return 0;

  const slot = await suggestSlot(task, now);
  if (!slot) return 0;
  // An inbox item is only raised for a gap that is close: free now, not free tonight.
  if (!overdue && slot.at.getTime() - now.getTime() > 90 * MINUTE) return 0;

  const time = formatTime(slot.at, settings.timezone);
  const html = overdue
    ? `💡 Sir, ${b(task.title)} is still open. ${esc(sentence(slot.reason))}: shall I put it at ${b(time)}?`
    : `💡 Sir, ${esc(slot.reason)}. ${b(task.title)} at ${b(time)}?`;
  // Guessable answers as buttons, and a way out for anything else.
  const keyboard = new InlineKeyboard()
    .text(`Yes, ${time}`, data("move", task.id, Math.round(slot.at.getTime() / MINUTE)))
    .text("Tomorrow", data("tomorrow", task.id))
    .row()
    .text(overdue ? "Drop it" : "Not today", overdue ? data("drop", task.id) : `sg:no:${task.id}`)
    .text("Other…", `oth:${task.id}`);

  await retire({ kinds: ["prompt"], taskId: task.id }, now);
  const messageId = await sendHtml(bot, chatId, html, { keyboard, silent: !overdue && task.priority === 4 });
  await track(messageId, "prompt", { taskId: task.id });
  const { error } = await db.from("reminders").insert({ task_id: task.id, fire_at: now.toISOString(), kind: "suggest", attempt: 0, state: "sent", sent_at: new Date().toISOString(), telegram_message_id: messageId });
  if (error) console.error(`runSuggestions: ${error.message}`);
  await logMessage("tony", plain(html));
  return 1;
}

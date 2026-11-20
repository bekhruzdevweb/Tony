import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { retire, sendHtml, track } from "./chat-log";
import { requireDb } from "./db";
import { env } from "./env";
import { b, esc, plain } from "./html";
import { logMessage } from "./messages";
import { timeOnDay } from "./routine";
import { data } from "./reminder-messages";
import { HOURLY_MESSAGE_CAP } from "./reminders";
import type { Settings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, inWindow, minuteOfDay } from "./time";

/**
 * Tony's unprompted suggestions. When a task is overdue, he says where he
 * will put it ("I'll put it at 21:00, your workout time") and offers
 * [✓ 21:00] [Tomorrow] [Drop] [Other…]; the time comes from his routine and
 * is free for the task's whole length. Inbox items (no time, no day) are
 * never given a time he did not ask for. At most three a day, never two
 * within two hours, never at night.
 */
export const MAX_SUGGESTIONS_PER_DAY = 3;
const MIN_GAP_MINUTES = 120;
/** How long a task must be overdue before Tony raises it (its own reminders come first). */
const OVERDUE_MINUTES = 45;
const MINUTE = 60_000;


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
  // Prayers are never suggested, moved or chased.
  const tasks = (taskRows.data as Task[]).filter((task) => task.kind !== "prayer");
  const hasReminder = new Set(((pendingRows.data ?? []) as { task_id: number | null }[]).map((row) => Number(row.task_id)));
  const suggested = new Set(made.map((row) => Number(row.task_id)));
  const fresh = (task: Task) => !suggested.has(task.id) && task.status !== "in_progress";

  // First choice: something overdue whose own reminders have run their course.
  const overdue = tasks
    .filter((task) => fresh(task) && task.due_at && now.getTime() - new Date(task.due_at).getTime() > OVERDUE_MINUTES * MINUTE && !hasReminder.has(task.id))
    .sort((x, y) => x.priority - y.priority || x.due_at!.localeCompare(y.due_at!))[0];
  // Inbox items are never offered a time he did not ask for.
  const task = overdue;
  if (!task) return 0;

  // Today, at its own time of day if that is still ahead and free, else where his routine puts it.
  const slot = await timeOnDay(task, now, now);
  if (!slot || slot.at.getTime() <= now.getTime()) return 0;

  const time = formatTime(slot.at, settings.timezone);
  const html = `💡 Sir, ${b(task.title)} is still open. I'll put it at ${b(time)}${slot.why ? `, ${esc(slot.why)}` : ""}.`;
  // ✓ takes it; the others are the ways out.
  const keyboard = new InlineKeyboard()
    .text(`✓ ${time}`, data("move", task.id, Math.round(slot.at.getTime() / MINUTE)))
    .text("Tomorrow", data("tomorrow", task.id))
    .row()
    .text("Drop it", data("drop", task.id))
    .text("✏️ Other…", `oth:${task.id}`);

  await retire({ kinds: ["prompt"], taskId: task.id }, now);
  const messageId = await sendHtml(bot, chatId, html, { keyboard, silent: !overdue && task.priority === 4 });
  await track(messageId, "prompt", { taskId: task.id });
  const { error } = await db.from("reminders").insert({ task_id: task.id, fire_at: now.toISOString(), kind: "suggest", attempt: 0, state: "sent", sent_at: new Date().toISOString(), telegram_message_id: messageId });
  if (error) console.error(`runSuggestions: ${error.message}`);
  await logMessage("tony", plain(html));
  return 1;
}

import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { runAction } from "./actions";
import { requireDb } from "./db";
import { logMessage } from "./messages";
import { data } from "./reminder-messages";
import type { Settings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, minuteOfDay, parseClock } from "./time";

/** A brief that could not go out on time is still sent for this long, then skipped for the day. */
const LATE_WINDOW_MINUTES = 180;
const SEND_TIMEOUT_MS = 8_000;
const DAY_MS = 24 * 60 * 60_000;
/** Spec: inbox items untouched for 3 days get a nudge. */
const STALE_DAYS = 3;
const MAX_CARRIED_PROMPTS = 2;

const MORNING = 0;
const EVENING = 1;

const plural = (n: number, one: string, many = `${one}s`) => `${n === 1 ? "One" : spell(n)} ${n === 1 ? one : many}`;
const spell = (n: number) => ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][n] ?? String(n);
const lower = (title: string) => (/^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title);

function list(items: string[], max = 6): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

type Sender = (text: string, keyboard?: InlineKeyboard, options?: { silent?: boolean; taskId?: number; kind?: "brief" | "stale"; attempt?: number }) => Promise<void>;

/**
 * Records every unprompted message as a reminder row, so the hourly cap
 * counts it, a reply to it finds its task, and "sent today?" has an answer.
 */
function sender(bot: Bot, chatId: number, now: Date): Sender {
  return async (text, keyboard, options = {}) => {
    const sent = await bot.api.sendMessage(
      chatId,
      text,
      { reply_markup: keyboard, disable_notification: options.silent },
      AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as Parameters<typeof bot.api.sendMessage>[3],
    );
    const { error } = await requireDb().from("reminders").insert({
      task_id: options.taskId ?? null,
      fire_at: now.toISOString(),
      kind: options.kind ?? "brief",
      attempt: options.attempt ?? 0,
      state: "sent",
      sent_at: new Date().toISOString(),
      telegram_message_id: sent.message_id,
    });
    if (error) console.error("Could not record a brief:", error.message);
    await logMessage("tony", text);
  };
}

async function openTasks(): Promise<Task[]> {
  const { data: rows, error } = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).limit(500);
  if (error) throw new Error(`briefs: ${error.message}`);
  return rows as Task[];
}

async function alreadySent(which: number, since: Date): Promise<boolean> {
  const { count, error } = await requireDb()
    .from("reminders")
    .select("id", { count: "exact", head: true })
    .eq("kind", "brief")
    .eq("attempt", which)
    .is("task_id", null)
    .gte("sent_at", since.toISOString());
  if (error) throw new Error(`briefs: ${error.message}`);
  return (count ?? 0) > 0;
}

/** True during the window in which a brief set for `clock` should go out. */
function isTime(clock: string, now: Date, timeZone: string): boolean {
  const late = minuteOfDay(now, timeZone) - parseClock(clock);
  return late >= 0 && late < LATE_WINDOW_MINUTES;
}

/** "Monday", or "yesterday" when it was. */
function dayName(at: Date, now: Date, timeZone: string): string {
  const today = dayBounds(now, timeZone).start.getTime();
  if (at.getTime() >= today - DAY_MS) return "yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(at);
}

export function morningText(today: Task[], carried: Task[], timeZone: string): string {
  const parts = ["Good morning, sir."];
  if (today.length > 0) {
    const items = today.map((task) => `${lower(task.title)} ${formatTime(new Date(task.due_at!), timeZone)}`);
    parts.push(`Today: ${today.length} ${today.length === 1 ? "task" : "tasks"}. ${list(items)[0].toUpperCase()}${list(items).slice(1)}.`);
  } else {
    parts.push("Nothing is scheduled for today.");
  }
  if (carried.length > 0) parts.push(`${plural(carried.length, "item")} carried over.`);
  return parts.join(" ");
}

/**
 * Morning brief: today's tasks, then a question for each task left open from
 * an earlier day, then a quiet nudge for the stalest inbox item.
 */
async function morningBrief(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const send = sender(bot, chatId, now);
  const { start, end } = dayBounds(now, settings.timezone);
  const tasks = await openTasks();
  const dated = tasks.filter((task) => task.due_at);
  const today = dated.filter((task) => new Date(task.due_at!).getTime() >= start.getTime() && new Date(task.due_at!).getTime() < end.getTime());
  const carried = dated.filter((task) => new Date(task.due_at!).getTime() < start.getTime());

  const appUrl = settings.app_url?.startsWith("https://") ? settings.app_url : undefined;
  await send(morningText(today, carried, settings.timezone), appUrl ? new InlineKeyboard().webApp("Open app", appUrl) : undefined, { attempt: MORNING });
  let sent = 1;

  // Missed tasks come back, one question each, oldest first.
  for (const task of carried.slice(0, MAX_CARRIED_PROMPTS)) {
    const keyboard = new InlineKeyboard()
      .text("Today", data("today", task.id))
      .text("Tomorrow", data("tomorrow", task.id))
      .text("Drop", data("drop", task.id));
    await send(
      `One item from ${dayName(new Date(task.due_at!), now, settings.timezone)} remains open: ${lower(task.title)}. Shall I put it on today?`,
      keyboard,
      { taskId: task.id, kind: "brief", attempt: 2 },
    );
    sent++;
  }

  // One forgotten inbox item a day, asked about quietly, and not again for three days.
  const stale = tasks
    .filter((task) => task.status === "inbox" && now.getTime() - new Date(task.updated_at).getTime() >= STALE_DAYS * DAY_MS)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  for (const task of stale) {
    const recent = await requireDb()
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("task_id", task.id)
      .eq("kind", "stale")
      .gte("sent_at", new Date(now.getTime() - STALE_DAYS * DAY_MS).toISOString());
    if (recent.error) throw new Error(`briefs: ${recent.error.message}`);
    if ((recent.count ?? 0) > 0) continue;
    const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY_MS);
    const keyboard = new InlineKeyboard()
      .text("Tomorrow", data("tomorrow", task.id))
      .text("This weekend", data("weekend", task.id))
      .text("Drop", data("drop", task.id));
    await send(`Sir, "${task.title}" has sat in the inbox for ${days} days. Shall I schedule it?`, keyboard, {
      taskId: task.id,
      kind: "stale",
      silent: true,
    });
    sent++;
    break;
  }
  return sent;
}

/** Open tasks that were due by the end of today. */
async function leftToday(now: Date, timeZone: string): Promise<Task[]> {
  const { end } = dayBounds(now, timeZone);
  return (await openTasks()).filter((task) => task.due_at && new Date(task.due_at).getTime() < end.getTime());
}

const reviewKeyboard = () =>
  new InlineKeyboard().text("Move all", "ev:moveall").text("Choose", "ev:choose").text("Leave them", "ev:leave");

function chooseKeyboard(tasks: Task[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const task of tasks.slice(0, 8)) {
    const title = task.title.length > 22 ? `${task.title.slice(0, 21)}…` : task.title;
    keyboard.text(`${title} → tomorrow`, `ev:tom:${task.id}`).text("Drop", `ev:drop:${task.id}`).row();
  }
  return keyboard.text("That will do", "ev:leave");
}

/** Evening review: what is still open, and whether to move it. */
async function eveningReview(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const send = sender(bot, chatId, now);
  const left = await leftToday(now, settings.timezone);
  if (left.length === 0) {
    // Nothing to decide. Say so only if there was a day's work to speak of.
    const { start } = dayBounds(now, settings.timezone);
    const done = await requireDb().from("tasks").select("id", { count: "exact", head: true }).eq("status", "done").gte("completed_at", start.toISOString());
    if (done.error) throw new Error(`briefs: ${done.error.message}`);
    const text = (done.count ?? 0) > 0 ? "Evening, sir. Everything for today is done." : undefined;
    // Recorded either way, so the review is not attempted again tonight.
    if (text) await send(text, undefined, { attempt: EVENING, silent: true });
    else await requireDb().from("reminders").insert({ fire_at: now.toISOString(), kind: "brief", attempt: EVENING, state: "cancelled", sent_at: now.toISOString() });
    return text ? 1 : 0;
  }
  const names = list(left.map((task) => lower(task.title)));
  const text =
    left.length === 1
      ? `Evening, sir. One task is still open: ${names}. Move it to tomorrow?`
      : `Evening, sir. ${spell(left.length)} tasks are still open: ${names}. Move them to tomorrow?`;
  await send(text, reviewKeyboard(), { attempt: EVENING });
  return 1;
}

/**
 * Called from the minute tick. Sends the morning brief and the evening
 * review once each per day, at the times set in Settings.
 */
export async function runBriefs(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const { start } = dayBounds(now, settings.timezone);
  let sent = 0;
  if (isTime(settings.brief_morning, now, settings.timezone) && !(await alreadySent(MORNING, start))) {
    sent += await morningBrief(bot, chatId, settings, now);
  }
  if (isTime(settings.brief_evening, now, settings.timezone) && !(await alreadySent(EVENING, start))) {
    sent += await eveningReview(bot, chatId, settings, now);
  }
  return sent;
}

export type EveningOutcome = { text?: string; toast?: string; keyboard: InlineKeyboard | null };

/** The evening review's buttons. Plain code, like every other button. */
export async function runEvening(action: string, taskId: number | undefined, now = new Date()): Promise<EveningOutcome> {
  const timeZone = "Asia/Tashkent";
  switch (action) {
    case "moveall": {
      const left = await leftToday(now, timeZone);
      for (const task of left) await runAction("tomorrow", task.id, undefined, now);
      return { text: left.length ? `Moved ${left.length === 1 ? "it" : `all ${left.length}`} to tomorrow, sir.` : "There was nothing left to move, sir.", keyboard: null };
    }
    case "choose": {
      const left = await leftToday(now, timeZone);
      return left.length ? { keyboard: chooseKeyboard(left) } : { text: "Nothing is left open, sir.", keyboard: null };
    }
    case "tom":
    case "drop": {
      if (taskId === undefined) return { keyboard: null };
      const outcome = await runAction(action === "tom" ? "tomorrow" : "drop", taskId, undefined, now);
      const left = await leftToday(addMinutes(now, 0), timeZone);
      return left.length ? { toast: outcome.text, keyboard: chooseKeyboard(left) } : { text: "All settled, sir.", keyboard: null };
    }
    default:
      return { text: "Very good, sir. They stay where they are.", keyboard: null };
  }
}

import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { runAction } from "./actions";
import { retire, sendHtml, track, type MessageKind } from "./chat-log";
import { requireDb } from "./db";
import { env } from "./env";
import { b, code, esc, expandable, i, plain } from "./html";
import { logMessage } from "./messages";
import { sendMissedPoll, sendPlanPoll, sendWeekPoll } from "./polls";
import { data } from "./reminder-messages";
import type { Settings } from "./settings";
import { sayAloud } from "./speech";
import { OPEN_STATUSES, type Task } from "./tasks";
import { dayBounds, formatTime, minuteOfDay, parseClock, TIMEZONE } from "./time";
import { dayView, loadProjects, taskLine } from "./views";

/** A brief that could not go out on time is still sent for this long, then skipped for the day. */
const LATE_WINDOW_MINUTES = 180;
const DAY_MS = 24 * 60 * 60_000;
/** Spec: inbox items untouched for 3 days get a nudge. */
const STALE_DAYS = 3;
const MAX_MISSED_POLLS = 2;

// Which daily message a "brief" row in the reminders table stands for.
const MORNING = 0;
const EVENING = 1;
const WEEKLY = 3;

const spell = (n: number) => ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][n] ?? String(n);
const shortDay = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
const weekdayOf = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(at);

/**
 * Notes an unprompted message in the reminders table, so the hourly cap
 * counts it, a reply to it finds its task, and "sent today?" has an answer.
 */
async function record(now: Date, messageId: number | null, attempt: number, options: { taskId?: number; kind?: "brief" | "stale" } = {}): Promise<void> {
  const { error } = await requireDb().from("reminders").insert({
    task_id: options.taskId ?? null,
    fire_at: now.toISOString(),
    kind: options.kind ?? "brief",
    attempt,
    state: messageId === null ? "cancelled" : "sent",
    sent_at: new Date().toISOString(),
    telegram_message_id: messageId,
  });
  if (error) console.error("Could not record a brief:", error.message);
}

async function send(
  bot: Bot,
  chatId: number,
  html: string,
  options: { keyboard?: InlineKeyboard; silent?: boolean; kind: MessageKind; taskId?: number },
): Promise<number> {
  const messageId = await sendHtml(bot, chatId, html, options);
  await track(messageId, options.kind, { taskId: options.taskId });
  await logMessage("tony", plain(html));
  return messageId;
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

/**
 * Morning brief: the day as a checklist, then a poll for each task left open
 * from an earlier day, then a quiet nudge for the stalest inbox item.
 */
async function morningBrief(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const tasks = await openTasks();
  const { start } = dayBounds(now, settings.timezone);
  const carried = tasks.filter((task) => task.due_at && new Date(task.due_at).getTime() < start.getTime());
  const inboxCount = tasks.filter((task) => task.status === "inbox").length;

  const view = await dayView(now, now, { lead: "Good morning, sir." });
  const html = inboxCount > 0 ? `${view.html}\n\n📥 ${i(`${inboxCount} in the inbox`)}` : view.html;
  const appUrl = settings.app_url?.startsWith("https://") ? settings.app_url : undefined;
  if (appUrl) view.keyboard.webApp("Open app", appUrl);

  // Yesterday's brief and plan make way for today's.
  await retire({ kinds: ["brief:morning", "plan"] }, now);
  const briefId = await send(bot, chatId, html, { keyboard: view.keyboard, kind: "brief:morning" });
  await record(now, briefId, MORNING);
  let sent = 1;
  if (env.ttsSpeakAll) {
    // The brief in a sentence or two, said cheerfully.
    const first = view.open[0];
    const spoken = [
      "Good morning, sir.",
      view.open.length ? `${view.open.length === 1 ? "One task" : `${view.open.length} tasks`} today${first ? `, starting with ${first.title} at ${formatTime(new Date(first.due_at!), settings.timezone)}` : ""}.` : "Nothing is scheduled for today.",
      view.overdue.length ? `${view.overdue.length === 1 ? "One item is" : `${view.overdue.length} items are`} carried over.` : "",
    ].join(" ");
    const voiceId = await sayAloud(bot, chatId, spoken, "brief", { now, silent: true });
    if (voiceId !== undefined) await track(voiceId, "brief:morning");
  }

  // Missed tasks come back, one question each, oldest first.
  for (const task of carried.slice(0, MAX_MISSED_POLLS)) {
    await retire({ kinds: ["prompt"], taskId: task.id }, now);
    const pollId = await sendMissedPoll(bot, chatId, task, now);
    await record(now, pollId, 2, { taskId: task.id });
    sent++;
  }

  // One forgotten inbox item a day, asked about quietly, and not again for three days.
  const stale = tasks
    .filter((task) => task.status === "inbox" && now.getTime() - new Date(task.updated_at).getTime() >= STALE_DAYS * DAY_MS)
    .sort((x, y) => x.updated_at.localeCompare(y.updated_at));
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
    await retire({ kinds: ["stale"], taskId: task.id }, now);
    const id = await send(bot, chatId, `📥 Sir, ${b(task.title)} has sat in the inbox for ${b(`${days} days`)}. Shall I schedule it?`, {
      keyboard,
      silent: true,
      kind: "stale",
      taskId: task.id,
    });
    await record(now, id, 0, { taskId: task.id, kind: "stale" });
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

/** What was completed today, newest last. */
async function doneToday(now: Date, timeZone: string): Promise<Task[]> {
  const { start } = dayBounds(now, timeZone);
  const { data: rows, error } = await requireDb().from("tasks").select().eq("status", "done").gte("completed_at", start.toISOString()).order("completed_at");
  if (error) throw new Error(`briefs: ${error.message}`);
  return rows as Task[];
}

/**
 * Evening review: what is still open and what got done, then the question of
 * tomorrow. With several candidates that question is a poll ("Which ones
 * tomorrow?"); with one, three buttons.
 */
async function eveningReview(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const timeZone = settings.timezone;
  const [left, done, all, projects] = await Promise.all([leftToday(now, timeZone), doneToday(now, timeZone), openTasks(), loadProjects()]);
  if (left.length === 0 && done.length === 0) {
    // Nothing to review. Recorded, so the review is not attempted again tonight.
    await record(now, null, EVENING);
    return 0;
  }

  const parts = [`<b>🌙 Evening review · ${esc(shortDay(now, timeZone))}</b>`];
  if (left.length > 0) {
    const lines = left.map((task) => {
      const at = new Date(task.due_at!);
      const late = at.getTime() < now.getTime() && task.status !== "in_progress";
      const sameDay = at.getTime() >= dayBounds(now, timeZone).start.getTime();
      return `${late ? "⚠️ " : ""}${taskLine(task, projects, sameDay ? formatTime(at, timeZone) : `${weekdayOf(at, timeZone)} ${formatTime(at, timeZone)}`)}`;
    });
    parts.push([b(`Still open · ${left.length}`), ...lines].join("\n"));
  } else {
    parts.push("Everything for today is done, sir.");
  }
  if (done.length > 0) {
    const lines = [`✅ ${b(`Done today · ${done.length}`)}`, ...done.map((task) => `${code(formatTime(new Date(task.completed_at!), timeZone))} ${esc(task.title)}`)].join("\n");
    parts.push(done.length > 3 ? expandable(lines) : lines);
  }

  // Candidates for tomorrow: what is left, then the inbox, oldest first.
  const inbox = all.filter((task) => task.status === "inbox").sort((x, y) => x.created_at.localeCompare(y.created_at));
  const candidates = [...left, ...inbox];
  const usePoll = candidates.length >= 2;
  if (left.length === 1 && !usePoll) parts.push("Move it to tomorrow?");

  await retire({ kinds: ["brief:evening"] }, now);
  const reviewId = await send(bot, chatId, parts.join("\n\n"), {
    // With several candidates the poll asks which; either way Tony can plan tomorrow himself.
    keyboard: left.length > 0 && !usePoll ? reviewKeyboard().row().text("🧭 Plan tomorrow for me", "pl:new:tomorrow") : candidates.length > 0 ? new InlineKeyboard().text("🧭 Plan tomorrow for me", "pl:new:tomorrow") : undefined,
    silent: left.length === 0,
    kind: "brief:evening",
  });
  await record(now, reviewId, EVENING);
  let sent = 1;
  if (usePoll) {
    await sendPlanPoll(bot, chatId, candidates);
    sent++;
  }
  return sent;
}

/** Sunday: the week in three lines and one question. */
async function weeklyReview(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const db = requireDb();
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const [done, added, open] = await Promise.all([
    db.from("tasks").select("id", { count: "exact", head: true }).eq("status", "done").gte("completed_at", since),
    db.from("tasks").select("id", { count: "exact", head: true }).gte("created_at", since),
    openTasks(),
  ]);
  if (done.error || added.error) throw new Error(`briefs: ${(done.error ?? added.error)!.message}`);
  const overdue = open.filter((task) => task.due_at && new Date(task.due_at).getTime() < now.getTime()).length;
  const inbox = open.filter((task) => task.status === "inbox").length;

  const html = [
    `<b>📊 The week · to ${esc(shortDay(now, settings.timezone))}</b>`,
    [`✅ ${b(String(done.count ?? 0))} done`, `➕ ${b(String(added.count ?? 0))} added`, `⚠️ ${b(String(overdue))} overdue`, `📥 ${b(String(inbox))} in the inbox`].join("\n"),
  ].join("\n\n");
  const id = await send(bot, chatId, html, { silent: true, kind: "brief:evening" });
  await record(now, id, WEEKLY);
  await sendWeekPoll(bot, chatId);
  return 2;
}

/**
 * Called from the minute tick. Sends the morning brief and the evening
 * review once each per day at the times set in Settings, and the weekly
 * review after Sunday's evening review.
 */
export async function runBriefs(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  const { start } = dayBounds(now, settings.timezone);
  let sent = 0;
  if (isTime(settings.brief_morning, now, settings.timezone) && !(await alreadySent(MORNING, start))) {
    sent += await morningBrief(bot, chatId, settings, now);
  }
  if (isTime(settings.brief_evening, now, settings.timezone)) {
    if (!(await alreadySent(EVENING, start))) sent += await eveningReview(bot, chatId, settings, now);
    if (weekdayOf(now, settings.timezone) === "Sun" && !(await alreadySent(WEEKLY, start))) sent += await weeklyReview(bot, chatId, settings, now);
  }
  return sent;
}

export type EveningOutcome = { text?: string; toast?: string; keyboard: InlineKeyboard | null };

/** The evening review's buttons (used when there is a single task to decide). Texts are Telegram HTML. */
export async function runEvening(action: string, taskId: number | undefined, now = new Date()): Promise<EveningOutcome> {
  switch (action) {
    case "moveall": {
      const left = await leftToday(now, TIMEZONE);
      for (const task of left) await runAction("tomorrow", task.id, undefined, now);
      return { text: left.length ? `Moved ${left.length === 1 ? "it" : `all ${spell(left.length).toLowerCase()}`} to ${b("tomorrow")}, sir.` : "There was nothing left to move, sir.", keyboard: null };
    }
    case "choose": {
      const left = await leftToday(now, TIMEZONE);
      return left.length ? { keyboard: chooseKeyboard(left) } : { text: "Nothing is left open, sir.", keyboard: null };
    }
    case "tom":
    case "drop": {
      if (taskId === undefined) return { keyboard: null };
      const outcome = await runAction(action === "tom" ? "tomorrow" : "drop", taskId, undefined, now);
      const left = await leftToday(now, TIMEZONE);
      return left.length ? { toast: outcome.text ? plain(outcome.text) : undefined, keyboard: chooseKeyboard(left) } : { text: "All settled, sir.", keyboard: null };
    }
    default:
      return { text: "Very good, sir. They stay where they are.", keyboard: null };
  }
}

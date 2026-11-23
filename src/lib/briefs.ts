import { currentGoals } from "./memory-rules";
import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { runAction } from "./actions";
import { retire, sendHtml, track, type MessageKind } from "./chat-log";
import { markdownToHtml, sendRich } from "./rich";
import { stillOpenSection } from "./followups";
import { logEvent } from "./events";
import { requireDb } from "./db";
import { b, code, esc, expandable, i, plain } from "./html";
import { logMessage } from "./messages";
import { sendPlanPoll, sendWeekPoll } from "./polls";
import type { Settings } from "./settings";
import { postBoard, shortLabel } from "./today-board";
import { coachForBrief } from "./coach";
import { clashLinesFor } from "./brain/checks";
import { weekLine } from "./habit-view";
import { sayAloud } from "./speech";
import { isPrayer, OPEN_STATUSES, type Task, inDayOrder } from "./tasks";
import { dayBounds, formatDay, formatTime, minuteOfDay, parseClock, TIMEZONE } from "./time";
import { chasedToday } from "./main-priority";
import { dayView, loadProjects, taskLine } from "./views";

/** A brief that could not go out on time is still sent for this long, then skipped for the day. */
const LATE_WINDOW_MINUTES = 180;
const DAY_MS = 24 * 60 * 60_000;

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
  options: { keyboard?: InlineKeyboard; silent?: boolean; kind: MessageKind; taskId?: number; rich?: boolean },
): Promise<number> {
  const messageId = options.rich ? await sendRich(bot, chatId, html, options) : await sendHtml(bot, chatId, html, options);
  await track(messageId, options.kind, { taskId: options.taskId });
  await logMessage("tony", plain(html));
  return messageId;
}

/** Rows of buttons (from the follow-up ladder) as a Telegram keyboard. */
function rowsKeyboard(rows: { text: string; data: string }[][]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  rows.forEach((row, index) => {
    if (index > 0) keyboard.row();
    for (const button of row) {
      if (button.data.startsWith("url:")) keyboard.url(button.text, button.data.slice(4));
      else keyboard.text(button.text, button.data);
    }
  });
  return keyboard;
}

async function openTasks(): Promise<Task[]> {
  const { data: rows, error } = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).limit(500);
  if (error) throw new Error(`briefs: ${error.message}`);
  // Prayers are never "missed tasks", carried over or reviewed.
  return (rows as Task[]).filter((task) => !isPrayer(task));
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

const SPOKEN_LIMIT = 300;

/**
 * The spoken brief: a greeting, the day's key tasks (up to two by name),
 * and the coach's line. Parts are shortened, never the coach's line, until
 * it fits in about 300 characters.
 */
export function spokenBrief(open: Task[], carriedOver: number, coachLine: string | undefined, timeZone: string): string {
  // A one-word series name before a colon is part of the name when said aloud (23 Nov 08:00: "then Watch at
  // 10:00" for "Watch: Instagram Masterclass (Brock Johnson)"). A task with no time is named with no time.
  const spoken = (title: string) => shortLabel(title.replace(/^([^\s:]+):\s+/, "$1 "), 28);
  const named = (task: Task) => (task.anytime || !task.due_at ? spoken(task.title) : `${spoken(task.title)} at ${formatTime(new Date(task.due_at), timeZone)}`);
  const count = open.length === 1 ? "One task" : `${open.length} tasks`;
  const taskSentences = [
    open.length === 0 ? "Nothing is scheduled for today." : open.length === 1 ? `One task today: ${named(open[0])}.` : `${count} today, starting with ${named(open[0])}, then ${named(open[1])}.`,
    open.length === 0 ? "Nothing is scheduled for today." : `${count} today, starting with ${named(open[0])}.`,
    open.length === 0 ? "Nothing is scheduled for today." : `${count} today.`,
  ];
  const carried = carriedOver ? `${carriedOver === 1 ? "One item is" : `${carriedOver} items are`} carried over.` : "";
  for (const tasks of taskSentences) {
    for (const extra of [carried, ""]) {
      const spoken = ["Good morning, sir.", tasks, extra, coachLine ?? ""].filter(Boolean).join(" ");
      if (spoken.length <= SPOKEN_LIMIT) return spoken;
    }
  }
  return ["Good morning, sir.", coachLine ?? taskSentences[2]].join(" ");
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

  // The follow-up ladder (phase d): what is still open from earlier days, with its buttons, under the greeting.
  const open = await stillOpenSection(now).catch((error) => (console.error("Still open failed:", error), undefined));
  const view = await dayView(now, now, { skipCarried: Boolean(open) });
  // The coach: one personal line from the habit log, and each habit's facts.
  const coach = await coachForBrief(now);
  // Two things at once today: flagged so they can be sorted before the day starts. Tasks clashing with
  // one another are one line, and at most three lines are shown (22 Nov: six pairs filled the brief).
  const clashLines = clashLinesFor(view.open).map((line) => `⚠️ ${esc(line)}`);
  // His focus right now (this week's and this month's goals), right under the greeting.
  const goalRows = ((await requireDb().from("memory").select("id, fact, layer, goal, mentions, confirmed_at, created_at").eq("goal", true)).data ?? []) as Parameters<typeof currentGoals>[0];
  const goals = currentGoals(goalRows, now).slice(0, 3);
  const focus = goals.length ? `🎯 ${b("Focus")}: ${goals.map((goal) => esc(goal.fact)).join(" · ")}` : undefined;
  // His main priority today (22 Nov): the one thing Tony chases until it is done.
  const chased = await chasedToday(now).catch(() => undefined);
  // Every main priority is named (23 Nov 08:00: he has two, the brief named one).
  const dayEnd = dayBounds(now, settings.timezone).end.getTime();
  const mains = tasks.filter((task) => task.main_priority && (!task.due_at || new Date(task.due_at).getTime() < dayEnd));
  const main = mains.length > 1 ? `⭐ ${b("Main priorities")}: ${mains.map((task) => esc(task.title)).join(" · ")}` : chased ? `⭐ ${b("Main priority")}: ${esc(chased.task.title)}${chased.timed ? ` · ${b(formatTime(chased.due))}` : ""}` : undefined;
  // The day's list is on the pinned Today message right under the brief: the brief only counts it
  // (23 Nov 08:00: the same 20 lines came twice, one above the other).
  const boardThere = "today_message_id" in settings;
  const timedOpen = view.open.filter((task) => !task.anytime);
  const untimed = view.open.length - timedOpen.length;
  const summary = `📅 ${b(`Today · ${formatDay(now, now)}`)}\n${view.open.length === 0 ? "Nothing is planned." : [timedOpen.length ? `${timedOpen.length} with a time${timedOpen[0]?.due_at ? `, first at ${b(formatTime(new Date(timedOpen[0].due_at)))}` : ""}` : "", untimed ? `${untimed} with no time` : ""].filter(Boolean).join(" · ")}${view.open.length ? ". The list is pinned below." : ""}`;
  const html = ["Good morning, sir.", focus, main, open ? markdownToHtml(open.text) : undefined, boardThere ? summary : view.html, clashLines.length ? clashLines.join("\n") : undefined, coach.line ? `💬 ${i(esc(coach.line))}` : undefined, coach.section, inboxCount > 0 ? `📥 ${i(`${inboxCount} in the inbox`)}` : undefined]
    .filter(Boolean)
    .join("\n\n");

  // Yesterday's brief and plan make way for today's.
  await retire({ kinds: ["brief:morning", "plan"] }, now);
  // The brief is the summary; the ticking is done on the pinned Today message that follows it.
  // (Until the board's database update is applied, the brief keeps its own tick boxes.)
  const boardReady = "today_message_id" in settings;
  const openKeyboard = open ? rowsKeyboard(open.rows) : undefined;
  const briefId = await send(bot, chatId, html, { keyboard: openKeyboard ?? (boardReady ? undefined : view.keyboard), kind: "brief:morning", rich: !openKeyboard });
  if (open) await logEvent("followup", { task_ids: open.taskIds, brief: true });
  await record(now, briefId, MORNING);
  // A fresh Today message for the new day, pinned; yesterday's is unpinned and removed.
  if (boardReady) await postBoard(bot, chatId, now).catch((error) => console.error("Could not post the Today message:", error));
  const sent = 1;
  {
    // Said aloud: today's key tasks and the coach's one line, about 300 characters at most.
    const spoken = spokenBrief(view.open, view.overdue.length, coach.line, settings.timezone);
    const voiceId = await sayAloud(bot, chatId, spoken, "brief", { now, silent: true });
    if (voiceId !== undefined) await track(voiceId, "brief:morning");
  }

  // Missed tasks are in the brief's "⚠️ Still open" (one message, their buttons under it), never one poll each;
  // inbox items untouched for a week come in Sunday evening's review (phase d).
  void carried;
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
    // Timed ones by time, then the ones with no time, which are never "late" (23 Nov 21:00: six of them
    // stood there as "⚠️ 20:00").
    const lines = inDayOrder(left).map((task) => {
      const at = new Date(task.due_at!);
      if (task.anytime) return taskLine(task, projects, "no time");
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

  // The morning brief has served the day; the evening review takes its place.
  await retire({ kinds: ["brief:evening", "brief:morning"] }, now);
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

  // His habits' week and his plans' progress, from the log ("🔥 Reading 6/7", "📈 IELTS 5/6").
  const habitsWeek = await weekLine(now).catch(() => undefined);
  const html = [
    `<b>📊 The week · to ${esc(shortDay(now, settings.timezone))}</b>`,
    [`✅ ${b(String(done.count ?? 0))} done`, `➕ ${b(String(added.count ?? 0))} added`, `⚠️ ${b(String(overdue))} overdue`, `📥 ${b(String(inbox))} in the inbox`].join("\n"),
    ...(habitsWeek ? [esc(habitsWeek)] : []),
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

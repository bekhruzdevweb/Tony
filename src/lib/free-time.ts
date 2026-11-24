import "server-only";
import { requireDb } from "./db";
import { logEvent } from "./events";
import { getRoutine } from "./routine";
import { kindOf, parseClockText } from "./routine-rules";
import { budgetLeft, notify } from "./safety";
import { band, freeTimeText, freeUntilFrom, pickFreeItem, type Booked, type FreeItem, type FreeStats } from "./smart-rules";
import { choicesFor } from "./routine";
import { scheduleReminder, settleReminders } from "./reminders";
import { dayLoads } from "./smart-inbox";
import { ANYTIME_HOUR, OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatDay, localDate, minuteOfDay, parseLocalDateTime, TIMEZONE } from "./time";

/**
 * The 🌙 Free Time list and its suggestions (phase c, 21 Nov). "In my free
 * time", "someday": a task with no date, kept on its own list. When he is
 * free (a gap of an hour or more, a task finished early, three quiet hours,
 * or "I'm free"), Tony suggests one item: the kinds he says yes to at that
 * time of day first, then the one waiting longest; never the same one twice
 * in two days; at most two unasked a day, within the day's budget.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
/** Unasked free-time suggestions a day. */
export const FREE_TIME_PER_DAY = 2;

/** The Free Time list, oldest first. */
export async function freeTimeTasks(): Promise<Task[]> {
  const { data, error } = await requireDb().from("tasks").select().eq("free_time", true).in("status", OPEN_STATUSES).order("created_at");
  if (error) return [];
  return data as Task[];
}

/** What he has said yes and no to, by kind and part of the day. */
async function freeStats(now: Date): Promise<FreeStats> {
  const { data } = await requireDb().from("events").select("kind, detail").in("kind", ["freetime_offer", "freetime_answer"]).gte("created_at", new Date(now.getTime() - 60 * DAY_MS).toISOString()).limit(1000);
  const stats: FreeStats = {};
  for (const row of (data ?? []) as { kind: string; detail: { key?: string; answer?: string } }[]) {
    const key = row.detail?.key;
    if (!key) continue;
    stats[key] ??= { offered: 0, accepted: 0 };
    if (row.kind === "freetime_offer") stats[key].offered++;
    if (row.kind === "freetime_answer" && row.detail.answer === "now") stats[key].accepted++;
  }
  return stats;
}

/** Items offered in the last two days, and how many unasked offers went out today. */
async function recentOffers(now: Date): Promise<{ items: Set<number>; today: number; last?: Date }> {
  const { data } = await requireDb().from("events").select("detail, created_at").eq("kind", "freetime_offer").gte("created_at", new Date(now.getTime() - 2 * DAY_MS).toISOString()).order("created_at", { ascending: false });
  const rows = (data ?? []) as { detail: { task_id?: number; asked?: boolean }; created_at: string }[];
  const { start } = dayBounds(now, TIMEZONE);
  return {
    items: new Set(rows.map((row) => Number(row.detail?.task_id)).filter(Number.isFinite)),
    today: rows.filter((row) => !row.detail?.asked && new Date(row.created_at).getTime() >= start.getTime()).length,
    last: rows[0] ? new Date(rows[0].created_at) : undefined,
  };
}

/** When the next thing begins (a task, a prayer less 15 minutes, or his bedtime), or now while a task is under way, so "free until" is true. */
async function freeUntil(now: Date): Promise<Date> {
  const routine = await getRoutine();
  const sleep = parseClockText(routine.sleep) ?? 23 * 60;
  const { start } = dayBounds(now, TIMEZONE);
  const bedtime = new Date(start.getTime() + sleep * MINUTE);
  // From six hours back, so a long task that began earlier (or this very minute) is seen as under way.
  const { data } = await requireDb()
    .from("tasks")
    .select("due_at, kind, duration_minutes, anytime")
    .in("status", OPEN_STATUSES)
    .gt("due_at", new Date(now.getTime() - 6 * HOUR).toISOString())
    .lt("due_at", bedtime.toISOString())
    .order("due_at")
    .limit(50);
  return freeUntilFrom((data ?? []) as Booked[], now, bedtime);
}

export type FreeSuggestion = { text: string; rows: { text: string; data: string }[][]; taskId?: number };

/**
 * One item from the list for the time he has now, with [▶️ Do it now]
 * [📋 Show list] [⏰ Not now]; noted so it is not offered again for two days.
 */
export async function suggestFreeTime(now = new Date(), options: { asked?: boolean } = {}): Promise<FreeSuggestion | undefined> {
  const items = await freeTimeTasks();
  if (items.length === 0) return options.asked ? { text: "Your 🌙 Free Time list is empty, sir. Tell me something for it: \"in my free time, watch …\".", rows: [] } : undefined;
  const until = await freeUntil(now);
  const minutesFree = Math.max(0, Math.round((until.getTime() - now.getTime()) / MINUTE));
  const offers = await recentOffers(now);
  const hour = Math.floor(minuteOfDay(now) / 60);
  const pick = pickFreeItem(items as unknown as FreeItem[], { minutesFree: options.asked ? Math.max(minutesFree, 30) : minutesFree, hour, stats: await freeStats(now), offeredSince: offers.items });
  if (!pick) return options.asked ? { text: "Nothing on your Free Time list fits the time you have, sir.", rows: [[{ text: "📋 Show list", data: "ft:list:0" }]] } : undefined;
  const key = `${kindOf(pick.title)}:${band(hour)}`;
  await logEvent("freetime_offer", { task_id: pick.id, key, asked: Boolean(options.asked) });
  const text = freeTimeText(pick, until.getTime() - now.getTime() < 6 * HOUR ? until : undefined, now);
  return { text, taskId: pick.id, rows: [[{ text: "▶️ Do it now", data: `ft:now:${pick.id}` }, { text: "📋 Show list", data: "ft:list:0" }, { text: "⏰ Not now", data: `ft:later:${pick.id}` }]] };
}

/**
 * Unasked: when he has an hour or more free now, outside quiet hours and away
 * from waking and bedtime, and he finished something early, has been quiet
 * for three hours, or has not written for 45 minutes. At most two a day, two
 * hours apart, within the budget.
 */
export async function shouldSuggestFreeTime(now: Date): Promise<boolean> {
  const routine = await getRoutine();
  const minute = minuteOfDay(now);
  const wake = parseClockText(routine.wake) ?? 7 * 60;
  const sleep = parseClockText(routine.sleep) ?? 23 * 60;
  if (minute < wake + 60 || minute > sleep - 90) return false;
  const offers = await recentOffers(now);
  if (offers.today >= FREE_TIME_PER_DAY) return false;
  if (offers.last && now.getTime() - offers.last.getTime() < 2 * HOUR) return false;
  const db = requireDb();
  const started = await db.from("tasks").select("id", { count: "exact", head: true }).eq("status", "in_progress");
  if ((started.count ?? 0) > 0) return false;
  const until = await freeUntil(now);
  if (until.getTime() - now.getTime() < 60 * MINUTE) return false;
  const last = await db.from("messages").select("created_at").eq("role", "user").order("id", { ascending: false }).limit(1);
  const lastMessage = ((last.data ?? []) as { created_at: string }[])[0];
  const quietMinutes = lastMessage ? (now.getTime() - new Date(lastMessage.created_at).getTime()) / MINUTE : Infinity;
  const finished = await db.from("tasks").select("due_at, duration_minutes, completed_at").eq("status", "done").gte("completed_at", addMinutes(now, -15).toISOString());
  const early = ((finished.data ?? []) as { due_at: string | null; duration_minutes: number | null }[]).some((task) => task.due_at && new Date(task.due_at).getTime() + (task.duration_minutes ?? 30) * MINUTE - now.getTime() >= 30 * MINUTE);
  // He finished early, or he is not busy writing to Tony (three quiet hours certainly count).
  if (!(early || quietMinutes >= 45)) return false;
  return (await budgetLeft(now)) > 0;
}

/** Noted as one of the day's unasked messages. */
export const countFreeTime = (now: Date) => notify("free_time", now);

/** His tap on a suggestion: start it now, see the list, or not now (both noted, for learning). */
export async function answerFreeTime(action: string, taskId: number, now = new Date()): Promise<{ text: string; rows?: { text: string; data: string }[][] }> {
  const db = requireDb();
  if (action === "list") return freeTimeList();
  const task = (await db.from("tasks").select().eq("id", taskId).maybeSingle()).data as Task | null;
  if (!task) return { text: "That one is gone from the list, sir." };
  const key = `${kindOf(task.title)}:${band(Math.floor(minuteOfDay(now) / 60))}`;
  if (action === "now") {
    await db.from("tasks").update({ status: "in_progress", due_at: now.toISOString() }).eq("id", task.id);
    await logEvent("freetime_answer", { task_id: task.id, key, answer: "now" });
    return { text: `▶️ **${task.title}**: started. Enjoy it.` };
  }
  await logEvent("freetime_answer", { task_id: task.id, key, answer: "later" });
  return { text: `Another time, then. **${task.title}** stays on your 🌙 Free Time list.` };
}

/** The 🌙 Free Time list, oldest first, each with ▶️ to start it now. */
export async function freeTimeList(now = new Date()): Promise<{ text: string; rows: { text: string; data: string }[][] }> {
  const items = await freeTimeTasks();
  if (items.length === 0) return { text: "Your 🌙 Free Time list is empty, sir.", rows: [] };
  const lines = items.map((task, index) => {
    const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY_MS);
    const link = /https?:\/\//.test(task.notes ?? "") ? " · 🔗" : "";
    return `${index + 1}. **${task.title}**${link}${days >= 1 ? ` · ${days} ${days === 1 ? "day" : "days"}` : ""}`;
  });
  const rows: { text: string; data: string }[][] = [];
  items.slice(0, 10).forEach((task, index) => {
    if (index % 5 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: `▶️ ${index + 1}`, data: `ft:now:${task.id}` });
  });
  return { text: ["🌙 **Free Time**", ...lines].join("\n"), rows };
}

// ── Free Time items onto light days (Phase K, 23 Nov) ────────────────────

/** A day with fewer tasks than this is light: one Free Time item may go there. */
export const LIGHT_DAY_TASKS = 4;
/** How far ahead Tony looks for light days, from tomorrow. */
const LIGHT_DAYS_AHEAD = 7;
/** At most this many are placed in one go, one per day. */
const PLACED_PER_RUN = 3;

export type Placed = { id: number; title: string; at: Date };

/** The light days from tomorrow on, lightest-first order kept by date: pure, for the tests. */
export function lightDays(from: string, loads: Map<string, number>, days = LIGHT_DAYS_AHEAD, limit = LIGHT_DAY_TASKS): string[] {
  const out: string[] = [];
  let date = from;
  for (let n = 0; n < days; n++) {
    if ((loads.get(date) ?? 0) < limit) out.push(date);
    date = localDate(addMinutes(parseLocalDateTime(`${date}T12:00`)!, 24 * 60));
  }
  return out;
}

/**
 * "The videos I need to watch in my free time: if I don't have more tasks on some day, schedule it to that
 * day, but not all of them to the same day … I don't want them kept and never seen again" (23 Nov 05:37).
 * Once a day: each Free Time item waiting longest goes to a light day in the coming week, one item a day,
 * at the best free time there, three at most. One he sends back is left alone for two weeks.
 */
export async function placeFreeTime(now = new Date()): Promise<Placed[]> {
  const items = await freeTimeTasks();
  const waiting = items.filter((task) => !task.due_at);
  if (waiting.length === 0) return [];
  const db = requireDb();
  const sentBack = await db.from("events").select("detail").eq("kind", "freetime_back").gte("created_at", new Date(now.getTime() - 14 * DAY_MS).toISOString()).limit(200);
  const skip = new Set(((sentBack.data ?? []) as { detail: { task_id?: number } }[]).map((row) => Number(row.detail?.task_id)));
  const tomorrow = localDate(addMinutes(now, 24 * 60));
  const loads = await dayLoads(tomorrow, LIGHT_DAYS_AHEAD);
  const days = lightDays(tomorrow, loads);
  const placed: Placed[] = [];
  const queue = waiting.filter((task) => !skip.has(task.id));
  for (const day of days) {
    if (placed.length >= PLACED_PER_RUN || queue.length === 0) break;
    const task = queue[0];
    const options = await choicesFor(task, parseLocalDateTime(`${day}T12:00`)!, now);
    const best = options.find((option) => option.at.getTime() > now.getTime());
    if (!best) continue;
    // The day only: he gave these no time, so Tony gives none (one reminder at 20:00 that day).
    const at = parseLocalDateTime(`${day}T${String(ANYTIME_HOUR).padStart(2, "0")}:00`)!;
    const { error } = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo", free_time: false, anytime: true }).eq("id", task.id);
    if (error) continue;
    await scheduleReminder(task.id, at);
    await logEvent("freetime_placed", { task_id: task.id, day });
    placed.push({ id: task.id, title: task.title, at });
    queue.shift();
  }
  return placed;
}

/** What Tony says about it, with [↩ Back to list] for each. */
export function placedMessage(placed: Placed[], now: Date): { text: string; rows: { text: string; data: string }[][] } {
  const lines = placed.map((item) => `- **${item.title}** → ${formatDay(item.at, now)}, no time`);
  return {
    text: [`🌙 ${placed.length === 1 ? "A lighter day is coming, so I put one thing from your Free Time list on it" : "Lighter days are coming, so I spread these from your Free Time list, one a day"}:`, ...lines].join("\n"),
    rows: placed.map((item) => [{ text: `↩ Back to list: ${item.title.slice(0, 30)}`, data: `ft:back:${item.id}` }]),
  };
}

/** [↩ Back to list]: the item returns to the Free Time list with no date, and is not placed again for two weeks. */
export async function backToFreeTime(taskId: number): Promise<string> {
  const db = requireDb();
  const task = (await db.from("tasks").select().eq("id", taskId).maybeSingle()).data as Task | null;
  if (!task || !OPEN_STATUSES.includes(task.status)) return "That one is already settled, sir.";
  const { error } = await db.from("tasks").update({ due_at: null, status: "inbox", free_time: true, anytime: false }).eq("id", taskId);
  if (error) return "⚠️ That did not save, sir.";
  await settleReminders(taskId);
  await logEvent("freetime_back", { task_id: taskId });
  return `↩ **${task.title}** is back on your 🌙 Free Time list.`;
}

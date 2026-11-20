import "server-only";
import type { Bot } from "grammy";
import { sendHtml, track } from "./chat-log";
import { requireDb } from "./db";
import { habitFacts, habitName, habitStats, type HabitStats } from "./habits";
import { b, esc, i } from "./html";
import { logMessage } from "./messages";
import type { Settings } from "./settings";
import { sayAloud } from "./speech";
import type { Task } from "./tasks";
import { formatTime, inWindow, localDate, minuteOfDay } from "./time";

/**
 * Tony as a coach, by voice.
 *
 * Every number he says comes from the habit log (see habits.ts); the
 * sentences are fixed templates with those numbers put in, never written by
 * a model, so nothing is invented. The tone: warm on a streak, firmer when
 * a habit is slipping, never shaming.
 */
const NUDGE_LEAD_MINUTES = 30;
const MAX_NUDGES_A_DAY = 2;
/** A habit missed this many due days in a row is "slipping". */
const SLIPPING_DAYS = 3;
/** The slipping nudge waits until mid-morning. */
const SLIPPING_FROM = 10 * 60;

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/**
 * The one personal line for the morning brief, or undefined when there is
 * nothing true and useful to say. The habit most in need of a word comes first.
 */
export function coachLine(all: HabitStats[]): string | undefined {
  const open = all.filter((habit) => habit.daysTracked >= 2 || habit.lastDone);

  // Slipping: firm, with the way back in view.
  const slipping = open.filter((habit) => habit.missedRun >= SLIPPING_DAYS).sort((x, y) => y.missedRun - x.missedRun)[0];
  if (slipping) {
    const name = habitName(slipping.task.title);
    const since = slipping.daysSinceLast !== undefined ? `It's been ${days(slipping.daysSinceLast)} since your last ${name}, sir` : `Your ${name} hasn't been done in the ${days(slipping.daysTracked)} I've been keeping track, sir`;
    const best = slipping.best >= 2 ? `; your best streak was ${slipping.best}` : "";
    return `${since}${best}. One today puts you back on track.`;
  }

  // On a streak and due today: encouraging.
  const streaking = open.filter((habit) => habit.streak >= 2 && habit.dueToday && !habit.doneToday).sort((x, y) => y.streak - x.streak)[0];
  if (streaking) {
    const name = habitName(streaking.task.title);
    if (streaking.streak >= streaking.best && streaking.best >= 3) {
      return `Your ${name} is on ${days(streaking.streak)} in a row, sir, your best yet. One more today sets a new record.`;
    }
    return `Your ${name} is on a ${streaking.streak}-day streak, sir. Keep it going today.`;
  }

  // A shaky week: a nudge to turn it round.
  const shaky = open.filter((habit) => habit.missesThisWeek >= 2 && habit.dueToday).sort((x, y) => y.missesThisWeek - x.missesThisWeek)[0];
  if (shaky) {
    return `Your ${habitName(shaky.task.title)} was missed ${times(shaky.missesThisWeek)} this week, sir. Today is a good day to turn the week around.`;
  }
  return undefined;
}

/** The brief's habit section, as HTML: one line of facts per habit. */
export function habitsSection(all: HabitStats[]): string | undefined {
  if (all.length === 0) return undefined;
  return [`🔥 ${b("Habits")}`, ...all.map((habit) => `${esc(habit.task.title)} · ${i(habitFacts(habit))}`)].join("\n");
}

/** Everything the coach needs for the morning brief. Never throws. */
export async function coachForBrief(now = new Date()): Promise<{ line?: string; section?: string }> {
  try {
    const stats = await habitStats(now);
    return { line: coachLine(stats), section: habitsSection(stats) };
  } catch (error) {
    console.error("Coach: no brief line:", error);
    return {};
  }
}

/** The nudge for a habit due soon, or undefined. */
function beforeNudge(habit: HabitStats): { text: string; firm: boolean } {
  const name = habitName(habit.task.title);
  const at = formatTime(habit.dueAtToday!);
  if (habit.missedRun >= SLIPPING_DAYS) {
    const gap = habit.daysSinceLast !== undefined ? `It's been ${days(habit.daysSinceLast)} since the last one` : `It hasn't been done in the ${days(habit.daysTracked)} I've been keeping track`;
    return { text: `Your ${name} is at ${at}, sir. ${gap}; today is the day to start again.`, firm: true };
  }
  if (habit.streak >= 2) {
    return { text: `Your ${name} is at ${at}, sir: ${days(habit.streak)} in a row so far. Thirty minutes to get ready.`, firm: false };
  }
  return { text: `Your ${name} is at ${at}, sir. Thirty minutes to get ready.`, firm: false };
}

function slippingNudge(habit: HabitStats): string {
  const name = habitName(habit.task.title);
  const best = habit.best >= 2 ? ` Your best run was ${habit.best}; you've done it before.` : "";
  const gap = habit.daysSinceLast !== undefined ? `It's been ${days(habit.daysSinceLast)} since your last ${name}, sir.` : `Your ${name} hasn't been done in the ${days(habit.daysTracked)} I've been keeping track, sir.`;
  return `${gap}${best} Even a short one today counts.`;
}

/** Records a nudge so it is sent once; false if it was already sent (or cannot be recorded). */
async function claim(kind: string, taskId: number, day: string): Promise<boolean> {
  const { error } = await requireDb().from("coach_events").insert({ kind, task_id: taskId, day });
  if (!error) return true;
  if (error.code !== "23505") console.error(`Coach: ${error.message}`);
  return false;
}

async function nudgesToday(day: string): Promise<number> {
  const { data, error } = await requireDb().from("coach_events").select("id").eq("day", day).in("kind", ["nudge:before", "nudge:slipping", "nudge:task"]);
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

/**
 * From the minute tick: at most two short voice nudges a day, outside quiet
 * hours. (1) A habit due today and not started, 30 minutes before its time;
 * a key task (persistent or priority 1-2) likewise.
 * (2) A habit missed three due days or more in a row, once a day from
 * mid-morning. When voice is unavailable or saved for the brief, the same
 * words go as text. Returns how many were sent.
 */
export async function runCoach(bot: Bot, chatId: number, settings: Settings, now = new Date()): Promise<number> {
  if (inWindow(now, settings.quiet_start, settings.quiet_end, settings.timezone)) return 0;
  const day = localDate(now);
  let sent: number;
  try {
    sent = await nudgesToday(day);
  } catch (error) {
    // Without its table (migration 0011 not applied) the coach stays quiet.
    console.error("Coach is off:", error instanceof Error ? error.message : error);
    return 0;
  }
  if (sent >= MAX_NUDGES_A_DAY) return 0;

  const stats = await habitStats(now);
  const due: { habit: HabitStats; kind: string; text: string; firm: boolean }[] = [];
  for (const habit of stats) {
    const started = habit.task.status === "in_progress";
    // Only when it matters: the habit is slipping, or it is a key task (persistent, or priority 1-2).
    const matters = habit.missedRun >= SLIPPING_DAYS || habit.task.persistent || habit.task.priority <= 2;
    if (matters && habit.dueToday && habit.dueAtToday && !habit.doneToday && !started) {
      const minutesLeft = (habit.dueAtToday.getTime() - now.getTime()) / 60_000;
      if (minutesLeft > 0 && minutesLeft <= NUDGE_LEAD_MINUTES) due.push({ habit, kind: "nudge:before", ...beforeNudge(habit) });
    }
    // Slipping: once a day, unless it is due later today (the "before" nudge will speak to it then).
    const dueLater = habit.dueToday && habit.dueAtToday && habit.dueAtToday.getTime() > now.getTime() && !habit.doneToday;
    if (habit.missedRun >= SLIPPING_DAYS && !dueLater && !habit.doneToday && minuteOfDay(now, settings.timezone) >= SLIPPING_FROM) {
      due.push({ habit, kind: "nudge:slipping", text: slippingNudge(habit), firm: true });
    }
  }

  // Key one-off tasks (persistent, or priority 1-2) due within 30 minutes and not started.
  const soon = await requireDb()
    .from("tasks")
    .select()
    .is("repeat_rule", null)
    .eq("status", "todo")
    .gt("due_at", now.toISOString())
    .lte("due_at", new Date(now.getTime() + NUDGE_LEAD_MINUTES * 60_000).toISOString());
  if (soon.error) console.error(`Coach: ${soon.error.message}`);
  for (const task of (soon.data ?? []) as Task[]) {
    if (!task.persistent && task.priority > 2) continue;
    const at = formatTime(new Date(task.due_at!));
    due.push({ habit: { task } as HabitStats, kind: "nudge:task", text: `${task.title} is at ${at}, sir: thirty minutes. Time to get ready.`, firm: false });
  }

  let count = 0;
  for (const nudge of due) {
    if (sent + count >= MAX_NUDGES_A_DAY) break;
    if (!(await claim(nudge.kind, nudge.habit.task.id, day))) continue;
    const voiceId = await sayAloud(bot, chatId, nudge.text, nudge.firm ? "coach:firm" : "coach", { now, caption: esc(nudge.text) });
    const messageId = voiceId ?? (await sendHtml(bot, chatId, esc(nudge.text)));
    // Removed with the task's other reminders once it is done, skipped or moved.
    await track(messageId, "reminder", { taskId: nudge.habit.task.id });
    await logMessage("tony", nudge.text);
    count++;
  }
  return count;
}

/** The habits in a line each, for the brain's context: the only numbers it may quote. */
export async function habitsForPrompt(now = new Date()): Promise<string | undefined> {
  try {
    const stats = await habitStats(now);
    if (stats.length === 0) return undefined;
    return stats.map((habit) => `- ${habit.task.title}: ${habitFacts(habit)}`).join("\n");
  } catch {
    return undefined;
  }
}

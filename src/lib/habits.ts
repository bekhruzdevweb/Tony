import "server-only";
import { requireDb } from "./db";
import { OPEN_STATUSES, type Task } from "./tasks";
import { formatTime, localDate, parseLocalDateTime, TIMEZONE } from "./time";

/**
 * Habits: repeating tasks (daily, weekdays, weekly) and how they are going.
 *
 * Every time a repeating task is done or skipped, the day that occurrence
 * was due is written to habit_log. Streaks and misses are worked out from
 * that log and the task's rule, and from nothing else: a day before
 * tracking began, or before the task existed, is never counted as missed.
 * A skipped day is excused: it neither breaks a streak nor adds to it.
 */
export type HabitStats = {
  task: Task;
  /** Days in a row done, up to today (today counts once done; not yet done today does not break it). */
  streak: number;
  /** The longest run of days done since tracking began. */
  best: number;
  /** Due days missed in a row, counting back from yesterday. */
  missedRun: number;
  /** Due days this week (Monday to yesterday) neither done nor skipped. */
  missesThisWeek: number;
  /** The last day it was done, as YYYY-MM-DD, if ever. */
  lastDone?: string;
  /** Whole days since then. */
  daysSinceLast?: number;
  /** Today is one of its days. */
  dueToday: boolean;
  doneToday: boolean;
  /** Today's time for it, when today is one of its days. */
  dueAtToday?: Date;
  /** Days tracked so far (from the first day it could be counted to today). */
  daysTracked: number;
};

const DAY_MS = 24 * 60 * 60_000;
const asUtc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, days: number) => fromUtc(asUtc(day) + days * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((asUtc(to) - asUtc(from)) / DAY_MS);
/** 0 = Sunday ... 6 = Saturday. */
const weekdayOf = (day: string) => new Date(asUtc(day)).getUTCDay();

/** Whether a habit with this rule is due on `day`. A weekly habit keeps the weekday it was set for. */
function isDue(rule: Task["repeat_rule"], day: string, weeklyOn: number): boolean {
  if (rule === "daily") return true;
  if (rule === "weekdays") return weekdayOf(day) >= 1 && weekdayOf(day) <= 5;
  if (rule === "weekly") return weekdayOf(day) === weeklyOn;
  return false;
}

/** Records one occurrence of a repeating task as done or skipped. Never throws. */
export async function logHabit(task: Pick<Task, "id" | "due_at" | "repeat_rule">, how: "done" | "skipped", now = new Date()): Promise<void> {
  if (!task.repeat_rule) return;
  // The occurrence being closed is the one that was due; one ticked off early still belongs to its own day.
  const day = localDate(task.due_at ? new Date(task.due_at) : now);
  try {
    const { error } = await requireDb().from("habit_log").upsert({ task_id: task.id, day, outcome: how, at: now.toISOString() }, { onConflict: "task_id,day" });
    if (error) console.error(`logHabit: ${error.message}`);
  } catch (error) {
    console.error("logHabit:", error);
  }
}

/**
 * The stats for every open repeating task, from real data only. Returns an
 * empty list if the habit tables are not there yet.
 */
export async function habitStats(now = new Date()): Promise<HabitStats[]> {
  const db = requireDb();
  const [tasks, settings] = await Promise.all([
    db.from("tasks").select().not("repeat_rule", "is", null).in("status", OPEN_STATUSES).order("id"),
    db.from("settings").select("habits_since").limit(1).maybeSingle(),
  ]);
  if (tasks.error || settings.error) {
    console.error(`habitStats: ${(tasks.error ?? settings.error)!.message}`);
    return [];
  }
  const habits = (tasks.data ?? []) as Task[];
  if (habits.length === 0) return [];
  const logs = await db
    .from("habit_log")
    .select("task_id, day, outcome")
    .in("task_id", habits.map((task) => task.id))
    .gte("day", addDays(localDate(now), -400));
  if (logs.error) {
    console.error(`habitStats: ${logs.error.message}`);
    return [];
  }

  const today = localDate(now);
  const since = String((settings.data as { habits_since?: string } | null)?.habits_since ?? today).slice(0, 10);
  // This week starts on Monday.
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));

  return habits.map((task) => {
    const rows = (logs.data as { task_id: number; day: string; outcome: string }[]).filter((row) => Number(row.task_id) === task.id);
    const done = new Set(rows.filter((row) => row.outcome === "done").map((row) => String(row.day).slice(0, 10)));
    const skipped = new Set(rows.filter((row) => row.outcome === "skipped").map((row) => String(row.day).slice(0, 10)));
    const weeklyOn = task.due_at ? new Date(new Date(task.due_at).getTime() + 5 * 60 * 60_000).getUTCDay() : 1;
    const due = (day: string) => isDue(task.repeat_rule, day, weeklyOn);

    // Counting starts at the later of: the task's creation, and the start of tracking (or its first logged day, if earlier).
    const firstLogged = [...done, ...skipped].sort()[0];
    const trackingFrom = firstLogged && firstLogged < since ? firstLogged : since;
    const created = localDate(new Date(task.created_at));
    // The day a habit is set up is never a miss: it may have been set up after its time.
    const firstDue = done.has(created) || skipped.has(created) ? created : addDays(created, 1);
    const start = firstLogged && firstLogged < firstDue ? firstLogged : firstDue > trackingFrom ? firstDue : trackingFrom;

    const dueToday = due(today);
    const doneToday = done.has(today);

    // Current streak: back from today; today not yet done does not break it.
    let streak = 0;
    for (let day = today; day >= start; day = addDays(day, -1)) {
      if (!due(day) || skipped.has(day)) continue;
      if (done.has(day)) streak++;
      else if (day === today) continue;
      else break;
    }

    // Best streak: the longest run, forward from the start.
    let best = 0;
    let run = 0;
    for (let day = start; day <= today; day = addDays(day, 1)) {
      if (!due(day) || skipped.has(day)) continue;
      if (done.has(day)) best = Math.max(best, ++run);
      else if (day !== today) run = 0;
    }

    // Missed in a row, back from yesterday.
    let missedRun = 0;
    for (let day = addDays(today, -1); day >= start; day = addDays(day, -1)) {
      if (!due(day)) continue;
      if (done.has(day) || skipped.has(day)) break;
      missedRun++;
    }

    let missesThisWeek = 0;
    for (let day = monday > start ? monday : start; day < today; day = addDays(day, 1)) {
      if (due(day) && !done.has(day) && !skipped.has(day)) missesThisWeek++;
    }

    const lastDone = [...done].sort().pop();
    const dueAtToday = dueToday && task.due_at ? parseLocalDateTime(`${today}T${formatTime(new Date(task.due_at), TIMEZONE)}`) : undefined;
    return {
      task,
      streak,
      best,
      missedRun,
      missesThisWeek,
      lastDone,
      daysSinceLast: lastDone ? daysBetween(lastDone, today) : undefined,
      dueToday,
      doneToday,
      dueAtToday,
      daysTracked: Math.max(0, daysBetween(start, today) + 1),
    };
  });
}

/** A habit's name for speech and text: "Workout" reads as "workout" mid-sentence. */
export function habitName(title: string): string {
  const clean = title.split(/\s[–—-]\s|[:(]/)[0].trim();
  return /^[A-Z][a-z]/.test(clean) ? clean[0].toLowerCase() + clean.slice(1) : clean;
}

const shortDate = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(asUtc(day)));

/** One line of facts for the brief's text and the brain's context. */
export function habitFacts(stats: HabitStats): string {
  const parts = [
    stats.streak > 0 ? `${stats.streak}-day streak` : "no current streak",
    `best ${stats.best}`,
    stats.lastDone ? `last done ${stats.daysSinceLast === 0 ? "today" : stats.daysSinceLast === 1 ? "yesterday" : shortDate(stats.lastDone)}` : "not done since tracking began",
    `${stats.missesThisWeek} missed this week`,
  ];
  return parts.join(", ");
}

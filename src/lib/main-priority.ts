import "server-only";
import { requireDb } from "./db";
import type { Row } from "./followups";
import { chaseStep, chaseText, UNTIMED_HOUR, type ChaseStep } from "./main-priority-rules";
import { data } from "./reminder-messages";
import { OPEN_STATUSES, type Task } from "./tasks";
import { dayBounds, formatTime, localDate, parseLocalDateTime, TIMEZONE } from "./time";

/**
 * His main priority (22 Nov, his idea: "he doesn't let me leave it unfinished;
 * until it's done he keeps messaging me every half hour or hour if I don't
 * answer"). The rules are in main-priority-rules.ts; this reads the database
 * and makes the nudge. The buttons are the reminders' own (Start, Done, In 1
 * hour, Tomorrow or Skip), handled in plain code; every tap is noted (task_tap)
 * so Tony knows he answered.
 */

/** Today's main priority: the earliest open flagged task due today; one with no time, or left from an earlier day, from 10:00. */
export async function chasedToday(now: Date): Promise<{ task: Task; due: Date; timed: boolean } | undefined> {
  const { data: rows, error } = await requireDb().from("tasks").select().eq("main_priority", true).in("status", OPEN_STATUSES).limit(50);
  if (error) return undefined;
  const { start, end } = dayBounds(now, TIMEZONE);
  const fromTen = parseLocalDateTime(`${localDate(now)}T${String(UNTIMED_HOUR).padStart(2, "0")}:00`)!;
  const today = ((rows ?? []) as Task[]).flatMap((task) => {
    if (!task.due_at) return [{ task, due: fromTen, timed: false }];
    const at = new Date(task.due_at);
    if (at.getTime() >= end.getTime()) return [];
    if (at.getTime() < start.getTime()) return [{ task, due: fromTen, timed: false }];
    return [{ task, due: at, timed: true }];
  });
  return today.sort((a, b) => a.due.getTime() - b.due.getTime())[0];
}

/** The next main priority still to come (for the brief on a day without one), if any. */
export async function nextMainPriority(now: Date): Promise<Task | undefined> {
  const { data: rows } = await requireDb().from("tasks").select().eq("main_priority", true).in("status", OPEN_STATUSES).gte("due_at", now.toISOString()).order("due_at").limit(1);
  return ((rows ?? []) as Task[])[0];
}

/** The nudge to send now about his main priority, if one is due: its words and its buttons. */
export async function mainPriorityNudge(now: Date): Promise<{ text: string; rows: Row[]; taskId: number; step: ChaseStep } | undefined> {
  const chased = await chasedToday(now);
  if (!chased) return undefined;
  const { task, due, timed } = chased;
  const db = requireDb();
  const { start } = dayBounds(now, TIMEZONE);
  const [nudges, reminders, taps] = await Promise.all([
    db.from("events").select("detail, created_at").eq("kind", "main_nudge").gte("created_at", start.toISOString()).order("id", { ascending: false }).limit(50),
    db.from("reminders").select("kind, state, fire_at, sent_at").eq("task_id", task.id).order("id", { ascending: false }).limit(30),
    db.from("events").select("detail, created_at").eq("kind", "task_tap").gte("created_at", start.toISOString()).order("id", { ascending: false }).limit(100),
  ]);
  type Logged = { detail: { task_id?: number } | null; created_at: string };
  const today = (nudges.data ?? []) as Logged[];
  const mine = today.filter((row) => Number(row.detail?.task_id) === task.id);
  const tapped = ((taps.data ?? []) as Logged[]).filter((row) => Number(row.detail?.task_id) === task.id).map((row) => new Date(row.created_at).getTime());
  const touched = Math.max(new Date(task.updated_at).getTime(), ...tapped);
  const sent = (reminders.data ?? []) as { kind: string; state: string; fire_at: string; sent_at: string | null }[];
  const coming = sent.filter((row) => row.state === "scheduled" && (row.kind === "due" || row.kind === "nudge")).map((row) => new Date(row.fire_at).getTime());
  const last = Math.max(0, ...sent.map((row) => (row.sent_at ? new Date(row.sent_at).getTime() : 0)), ...mine.map((row) => new Date(row.created_at).getTime()));
  const step = chaseStep({
    now,
    due,
    status: task.status,
    startedAt: task.status === "in_progress" ? new Date(task.updated_at) : undefined,
    minutes: task.duration_minutes,
    nextReminderAt: coming.length ? new Date(Math.min(...coming)) : undefined,
    lastSentAt: last ? new Date(last) : undefined,
    nudgesToday: today.length,
    unanswered: mine.filter((row) => new Date(row.created_at).getTime() > touched).length,
  });
  if (!step) return undefined;
  // "Not today": a repeating session is skipped (it comes round on its own day); anything else moves to tomorrow.
  const notToday = { text: "Not today", data: task.repeat_rule ? data("skip", task.id) : data("tomorrow", task.id) };
  const rows: Row[] =
    step.kind === "check"
      ? [[{ text: "✓ Done", data: data("done", task.id) }, { text: "⏳ 30 more min", data: data("snooze", task.id, 30) }], [notToday]]
      : [
          [{ text: "▶️ Starting now", data: data("start", task.id) }, { text: "✓ Done", data: data("done", task.id) }],
          [{ text: "⏰ In 1 hour", data: data("snooze", task.id, 60) }, notToday],
        ];
  return { text: chaseText(step, task.title, due, now, timed ? formatTime(due) : undefined), rows, taskId: task.id, step };
}

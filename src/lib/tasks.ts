import "server-only";
import { requireDb } from "./db";
import { dayBounds, formatTime } from "./time";

export type TaskStatus = "inbox" | "todo" | "in_progress" | "done" | "skipped" | "dropped" | "draft";

export type Task = {
  id: number;
  title: string;
  notes: string | null;
  project_id: number | null;
  priority: number;
  status: TaskStatus;
  due_at: string | null;
  repeat_rule: "daily" | "weekdays" | "weekly" | null;
  /** The last local date a repeating task comes round (YYYY-MM-DD); absent or null: no end. */
  repeat_until?: string | null;
  /** His main priority: chased until it is done (main-priority.ts). */
  main_priority?: boolean;
  persistent: boolean;
  persistent_schedule: number[] | null;
  /** Minutes it takes, when known. */
  duration_minutes?: number | null;
  /** null for an ordinary task; "prayer" for one of the five daily prayers. */
  kind?: string | null;
  /** On the 🌙 Free Time list ("in my free time", "someday"): no date, suggested when he is free. */
  free_time?: boolean | null;
  /** A habit he chose to build (Phase H): streaks, check-ins and the coach. A plan's sessions are not habits. */
  habit?: boolean;
  /** A task for a day with no time (Phase J): shown as "anytime", one quiet check at 20:00 if still open. */
  anytime?: boolean;
  /** His words for a theme ("content", "ielts"), lower case, without the #. */
  tags?: string[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export const OPEN_STATUSES: TaskStatus[] = ["inbox", "todo", "in_progress"];

/** Tasks he does together on purpose carry this tag: they are never reported as a clash with each other. */
export const TOGETHER_TAG = "together";

/** A day's tasks in reading order: timed ones by time, then the ones with no time, his main priorities first. */
export function inDayOrder<T extends { due_at: string | null; anytime?: boolean | null; main_priority?: boolean | null }>(tasks: T[]): T[] {
  const rank = (task: T) => (task.anytime ? (task.main_priority ? 1 : 2) : 0);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (a.due_at ?? "").localeCompare(b.due_at ?? ""));
}

/** An anytime task's check comes at this hour of its day (Phase J). */
export const ANYTIME_HOUR = 20;

/** A task's time as he reads it: "09:00", or "anytime" for a task with no time (Phase J). */
export const clockOf = (task: { due_at: string | null; anytime?: boolean | null }): string => (task.anytime ? "no time" : task.due_at ? formatTime(new Date(task.due_at)) : "");

/**
 * Priorities as he named them (23 Nov): urgent (1) is chased the same day: 15 minutes after its time if
 * he does not answer, then every hour until he answers or it is done; important (2); normal (4).
 */
export const PRIORITY_NAMES: Record<number, string> = { 1: "urgent", 2: "important", 3: "important", 4: "normal" };
/** The urgent chase, in minutes after its time: 15 min, then hourly for the rest of the day (quiet hours end it). */
export const URGENT_LADDER = [0, 15, ...Array.from({ length: 14 }, (_, n) => 75 + n * 60)];

/** One of the five daily prayers (see prayer.ts): calm, kept out of counts, overdue lists and nudges. */
export const PRAYER_KIND = "prayer";
export const isPrayer = (task: { kind?: string | null }) => task.kind === PRAYER_KIND;
export const MAX_TITLE_LENGTH = 500;

/**
 * Whether words that could not be read by the brain are worth keeping as a
 * task. Questions ("can you…?", "what is…") and chat ("thank you", "hey
 * Tony") are not; short to-dos ("buy a notebook", "call the bank") are.
 */
export function looksLikeTask(text: string): boolean {
  const words = text.trim().toLowerCase();
  if (!words || words.length > 120) return false;
  if (/\?\s*$/.test(words)) return false;
  if (/^(hey|hi|hello|ok|okay|thanks|thank you|yes|no|well|so|what|why|how|when|where|who|which|can|could|would|should|will|do|does|did|is|are|am|was|were|have|has|tell|show|explain|please send|send me)\b/.test(words)) return false;
  return true;
}

/** A task with no date: it waits in the Inbox. */
export async function addInboxTask(title: string): Promise<Task> {
  const { data, error } = await requireDb()
    .from("tasks")
    .insert({ title: title.trim().slice(0, MAX_TITLE_LENGTH), status: "inbox" })
    .select()
    .single();
  if (error) throw new Error(`addInboxTask: ${error.message}`);
  return data as Task;
}

/** Undated tasks, oldest first. */
export async function listInbox(): Promise<Task[]> {
  const { data, error } = await requireDb()
    .from("tasks")
    .select()
    .eq("status", "inbox")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`listInbox: ${error.message}`);
  // The 🌙 Free Time list is its own list, not the inbox.
  return (data as Task[]).filter((task) => !task.free_time);
}

/** Open tasks due before the end of today, split into overdue and today. */
export async function listToday(now = new Date()): Promise<{ overdue: Task[]; today: Task[] }> {
  const { start, end } = dayBounds(now);
  const { data, error } = await requireDb()
    .from("tasks")
    .select()
    .in("status", OPEN_STATUSES)
    .lt("due_at", end.toISOString())
    .order("due_at", { ascending: true });
  if (error) throw new Error(`listToday: ${error.message}`);
  const tasks = data as Task[];
  const isOverdue = (task: Task) => new Date(task.due_at!).getTime() < start.getTime();
  return { overdue: tasks.filter(isOverdue), today: tasks.filter((t) => !isOverdue(t)) };
}

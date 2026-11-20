import "server-only";
import { requireDb } from "./db";
import { dayBounds } from "./time";

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
  persistent: boolean;
  persistent_schedule: number[] | null;
  /** Minutes it takes, when known. */
  duration_minutes?: number | null;
  /** null for an ordinary task; "prayer" for one of the five daily prayers. */
  kind?: string | null;
  /** On the 🌙 Free Time list ("in my free time", "someday"): no date, suggested when he is free. */
  free_time?: boolean | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export const OPEN_STATUSES: TaskStatus[] = ["inbox", "todo", "in_progress"];

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

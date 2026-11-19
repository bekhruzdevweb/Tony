import "server-only";
import { requireDb } from "./db";
import { dayBounds } from "./time";

export type TaskStatus = "inbox" | "todo" | "in_progress" | "done" | "skipped" | "dropped";

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
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export const OPEN_STATUSES: TaskStatus[] = ["inbox", "todo", "in_progress"];
export const MAX_TITLE_LENGTH = 500;

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
  return data as Task[];
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

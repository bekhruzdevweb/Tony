import "server-only";
import { requireDb } from "./db";
import { BIG3 } from "./big3-rules";
import { placeAnytime } from "./slots";
import { OPEN_STATUSES, type Task } from "./tasks";
import { localDate } from "./time";

/**
 * Chooses a task as one of a day's Big 3 (three at most). A task with no day, or on another day, is put on
 * that day with no time: his own clock time is kept when it is already on that day.
 */
export async function setBig3(id: number, day: string, now = new Date()): Promise<{ ok: true; task: Task } | { ok: false; error: string }> {
  const db = requireDb();
  const found = await db.from("tasks").select().eq("id", id).maybeSingle();
  const task = found.data as Task | null;
  if (!task || !OPEN_STATUSES.includes(task.status)) return { ok: false, error: "That task is not open any more" };
  const chosen = await db.from("tasks").select("id").eq("big3_on", day).in("status", OPEN_STATUSES);
  const ids = ((chosen.data ?? []) as { id: number }[]).map((row) => row.id);
  if (ids.includes(id)) return { ok: true, task };
  if (ids.length >= BIG3) return { ok: false, error: `Three are already chosen for that day: take one out first` };
  if (!task.due_at || localDate(new Date(task.due_at)) !== day) {
    if (!(await placeAnytime(id, day, now))) return { ok: false, error: "Could not put it on that day" };
  }
  const { data, error } = await db.from("tasks").update({ big3_on: day }).eq("id", id).select().maybeSingle();
  if (error || !data) return { ok: false, error: "Could not choose it" };
  return { ok: true, task: data as Task };
}

/** Takes a task out of its day's Big 3; it stays on the day. */
export async function clearBig3(id: number): Promise<boolean> {
  const { data, error } = await requireDb().from("tasks").update({ big3_on: null }).eq("id", id).select("id");
  return !error && (data ?? []).length > 0;
}

/** For Tony's prompt: "Today's Big 3: #12 Write reel script · #40 IELTS reading (2 chosen)". */
export async function big3ForPrompt(now = new Date()): Promise<string | undefined> {
  const today = localDate(now);
  const tomorrow = localDate(new Date(now.getTime() + 24 * 60 * 60_000));
  const { data, error } = await requireDb().from("tasks").select("id, title, status, big3_on").in("big3_on", [today, tomorrow]);
  if (error) return undefined;
  const rows = (data ?? []) as { id: number; title: string; status: string; big3_on: string }[];
  const line = (label: string, day: string) => {
    const picked = rows.filter((row) => row.big3_on === day);
    return picked.length ? `${label}: ${picked.map((row) => `#${row.id} ${row.status === "done" ? "☑" : "☐"} ${row.title}`).join(" · ")}` : `${label}: none chosen yet`;
  };
  return `${line("Today's Big 3", today)}\n${line("Tomorrow's Big 3", tomorrow)}`;
}

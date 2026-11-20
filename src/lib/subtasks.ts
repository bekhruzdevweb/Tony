import "server-only";
import { requireDb } from "./db";
import { firstSight } from "./dedupe";
import { allDone, listFromNotes, progress, type Subtask } from "./subtask-rules";
import { OPEN_STATUSES } from "./tasks";

export { allDone, progress, type Subtask };

/**
 * Subtasks: a task's parts, ticked one by one ("Post stories 1/3"). When the
 * last part is ticked, Tony asks before marking the task itself done.
 */
export async function subtasksFor(taskIds: number[]): Promise<Map<number, Subtask[]>> {
  const map = new Map<number, Subtask[]>();
  if (taskIds.length === 0) return map;
  const { data, error } = await requireDb().from("subtasks").select().in("task_id", taskIds).order("position").order("id");
  // Without the table (migration 0020 not applied) tasks simply have no parts.
  if (error) return map;
  for (const row of (data ?? []) as Subtask[]) {
    const list = map.get(Number(row.task_id)) ?? [];
    list.push({ ...row, task_id: Number(row.task_id) });
    map.set(Number(row.task_id), list);
  }
  return map;
}

/** Adds parts to a task, after the ones it has; a part it already has is not added twice. */
export async function addSubtasks(taskId: number, titles: string[]): Promise<Subtask[]> {
  const db = requireDb();
  const existing = (await subtasksFor([taskId])).get(taskId) ?? [];
  const known = new Set(existing.map((s) => s.title.toLowerCase()));
  const fresh = titles.map((t) => t.trim().slice(0, 200)).filter((t) => t && !known.has(t.toLowerCase()));
  if (fresh.length > 0) {
    const start = existing.reduce((max, s) => Math.max(max, s.position), -1) + 1;
    const { error } = await db.from("subtasks").insert(fresh.map((title, n) => ({ task_id: taskId, title, position: start + n })));
    if (error) throw new Error(`addSubtasks: ${error.message}`);
  }
  return (await subtasksFor([taskId])).get(taskId) ?? [];
}

/** Ticks or unticks one part. Returns the task's parts afterwards. */
export async function setSubtaskDone(id: number, done: boolean): Promise<{ taskId: number; subtasks: Subtask[] } | undefined> {
  const db = requireDb();
  const { data, error } = await db.from("subtasks").update({ done }).eq("id", id).select("task_id").maybeSingle();
  if (error) throw new Error(`setSubtaskDone: ${error.message}`);
  if (!data) return undefined;
  const taskId = Number((data as { task_id: number }).task_id);
  return { taskId, subtasks: (await subtasksFor([taskId])).get(taskId) ?? [] };
}

export async function removeSubtask(id: number): Promise<number | undefined> {
  const { data, error } = await requireDb().from("subtasks").delete().eq("id", id).select("task_id").maybeSingle();
  if (error) throw new Error(`removeSubtask: ${error.message}`);
  return data ? Number((data as { task_id: number }).task_id) : undefined;
}

/** The part of a task whose title best matches what he said ("the quiz" → "quiz"). */
export function findSubtask(subtasks: Subtask[], words: string): Subtask | undefined {
  const w = words.toLowerCase().replace(/^(the|a|an)\s+/, "").trim();
  return subtasks.find((s) => s.title.toLowerCase() === w) ?? subtasks.find((s) => s.title.toLowerCase().includes(w) || w.includes(s.title.toLowerCase()));
}

/**
 * Once: lists written into open tasks' notes become subtasks, and the list
 * leaves the notes. Runs on the first tick after this is deployed.
 */
export async function moveNoteListsOnce(): Promise<number> {
  if (!(await firstSight(-20261121))) return 0;
  const db = requireDb();
  const { data, error } = await db.from("tasks").select("id, notes").in("status", OPEN_STATUSES).not("notes", "is", null);
  if (error) return 0;
  let moved = 0;
  for (const row of (data ?? []) as { id: number; notes: string }[]) {
    const { parts, rest } = listFromNotes(row.notes);
    if (parts.length < 2) continue;
    const already = (await subtasksFor([row.id])).get(row.id) ?? [];
    if (already.length > 0) continue;
    await addSubtasks(row.id, parts);
    await db.from("tasks").update({ notes: rest || null }).eq("id", row.id);
    moved++;
  }
  if (moved) console.log(`Moved the lists in ${moved} tasks' notes to subtasks.`);
  return moved;
}

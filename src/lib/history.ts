import "server-only";
import { requireDb } from "./db";
import { describeChange, same, undoPatch, type HistoryEntry } from "./history-rules";
import { scheduleReminder, settleReminders } from "./reminders";
import { OPEN_STATUSES, type Task } from "./tasks";
import { formatTime } from "./time";

/**
 * /undo: the last changes to his tasks (recorded by the database, migration
 * 0022), and putting one back. Plain code, never the AI model.
 */

export type Change = { id: number; taskId: number; at: string; text: string };

/** The last changes that can still be undone, newest first, in his words. */
export async function recentChanges(limit = 10, now = new Date()): Promise<Change[]> {
  const { data, error } = await requireDb()
    .from("task_history")
    .select()
    .is("undone_at", null)
    .neq("action", "delete")
    .order("id", { ascending: false })
    .limit(limit * 3);
  if (error) throw new Error(`recentChanges: ${error.message}`);
  const entries = (data ?? []) as HistoryEntry[];
  // Saves made while creating a task (its notes, its parts) are part of "added": one action, one line.
  const created = new Map(entries.filter((entry) => entry.action === "insert").map((entry) => [entry.task_id, new Date(entry.created_at).getTime()]));
  const partOfCreating = (entry: HistoryEntry) => {
    if (entry.action !== "update" || !created.has(entry.task_id)) return false;
    const after = new Date(entry.created_at).getTime() - created.get(entry.task_id)!;
    return after >= 0 && after <= 15_000;
  };
  return entries
    .filter((entry) => undoPatch(entry) !== undefined && !partOfCreating(entry))
    .slice(0, limit)
    .map((entry) => ({ id: entry.id, taskId: entry.task_id, at: entry.created_at, text: describeChange(entry, now) }));
}

/**
 * Puts back exactly what one change changed (later changes stay), moves the
 * task's reminder with it, and confirms only what reads back.
 */
export async function undoChange(id: number, now = new Date()): Promise<string> {
  const db = requireDb();
  const found = await db.from("task_history").select().eq("id", id).maybeSingle();
  const entry = found.data as HistoryEntry | null;
  if (!entry) return "That change is no longer in the history, sir.";
  if (entry.undone_at) return "Already undone, sir.";
  const patch = undoPatch(entry);
  if (!patch) return "That one can't be undone, sir.";
  const current = (await db.from("tasks").select().eq("id", entry.task_id).maybeSingle()).data as Task | null;
  if (!current) return "That task no longer exists, sir.";

  const started = new Date(Date.now() - 1000);
  const { error } = await db.from("tasks").update(patch).eq("id", entry.task_id);
  if (error) throw new Error(`undoChange: ${error.message}`);
  const back = (await db.from("tasks").select().eq("id", entry.task_id).maybeSingle()).data as Task;
  // The reminder follows the task as it now is.
  if ("due_at" in patch || "status" in patch) {
    const due = back.due_at ? new Date(back.due_at) : undefined;
    if (OPEN_STATUSES.includes(back.status) && due && due.getTime() > now.getTime()) await scheduleReminder(back.id, due);
    else await settleReminders(back.id);
  }
  await db.from("task_history").update({ undone_at: now.toISOString() }).eq("id", id);
  // The database recorded the undo as a change too; it is not offered as one of "his" changes.
  const own = await db
    .from("task_history")
    .select("id")
    .eq("task_id", entry.task_id)
    .gt("id", id)
    .gte("created_at", started.toISOString())
    .order("id", { ascending: false })
    .limit(1);
  const ownId = ((own.data ?? []) as { id: number }[])[0]?.id;
  if (ownId !== undefined) await db.from("task_history").update({ undone_at: now.toISOString() }).eq("id", ownId);

  const record = back as unknown as Record<string, unknown>;
  if (Object.entries(patch).some(([field, value]) => !same(record[field], value))) return `⚠️ **${back.title}**: that did not go back, sir.`;
  if (entry.action === "insert") return `↩ **${back.title}**: removed again, sir.`;
  return `↩ **${back.title}**: back as it was before ${formatTime(new Date(entry.created_at))}, sir.`;
}

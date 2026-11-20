/**
 * His tasks' change history and /undo: the pure rules, tested in
 * tests/phase1.test.ts.
 *
 * The database records every change to a task (migration 0022): the whole
 * row before and after. /undo shows the last ten changes in his words and
 * puts back exactly the fields one of them changed, leaving later changes
 * alone.
 */
import { formatDay, formatTime } from "./time";

export type HistoryEntry = {
  id: number;
  task_id: number;
  action: "insert" | "update" | "delete";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
  undone_at: string | null;
};

/** The fields a change can touch and /undo can put back. */
export const UNDOABLE = ["title", "notes", "due_at", "status", "priority", "project_id", "duration_minutes", "persistent", "repeat_rule", "completed_at"] as const;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Equal as stored: timestamps by the moment they name, everything else as written. */
export function same(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (typeof x === "string" && typeof y === "string" && TIMESTAMP.test(x) && TIMESTAMP.test(y)) return new Date(x).getTime() === new Date(y).getTime();
  return JSON.stringify(x) === JSON.stringify(y);
}

/** The fields one change really changed. */
export function changedFields(entry: HistoryEntry): string[] {
  if (entry.action !== "update" || !entry.before || !entry.after) return [];
  return UNDOABLE.filter((field) => !same(entry.before![field], entry.after![field]));
}

const OPEN = new Set(["inbox", "todo", "in_progress", "draft"]);
const when = (iso: unknown, now: Date) => {
  const at = new Date(String(iso));
  return `${formatDay(at, now)} ${formatTime(at)}`;
};

/** "**Watch podcast**: moved from Sat 21 Nov 14:00 to Mon 23 Nov 10:00; notes changed". */
export function describeChange(entry: HistoryEntry, now: Date): string {
  const row = entry.after ?? entry.before ?? {};
  const title = `**${String(row.title ?? "A task")}**`;
  if (entry.action === "insert") return `${title}: added`;
  if (entry.action === "delete") return `${title}: deleted`;
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const fields = changedFields(entry);
  const parts: string[] = [];
  if (fields.includes("status")) {
    const status = String(after.status);
    if (status === "done") parts.push("done");
    else if (status === "dropped") parts.push("removed");
    else if (status === "skipped") parts.push("skipped");
    else if (status === "in_progress") parts.push("started");
    else if (!OPEN.has(String(before.status))) parts.push("reopened");
  }
  if (fields.includes("due_at")) {
    if (!before.due_at) parts.push(`scheduled for ${when(after.due_at, now)}`);
    else if (!after.due_at) parts.push("back to the inbox");
    else parts.push(`moved from ${when(before.due_at, now)} to ${when(after.due_at, now)}`);
  }
  if (fields.includes("title")) parts.push(`renamed from "${String(before.title)}"`);
  if (fields.includes("notes")) parts.push("notes changed");
  if (fields.some((field) => ["priority", "project_id", "duration_minutes", "persistent", "repeat_rule"].includes(field))) parts.push("details changed");
  return `${title}: ${parts.length ? parts.join("; ") : "changed"}`;
}

/**
 * What /undo writes back for one change: the fields it changed, as they
 * were before it. A task that was added is removed again (dropped, not
 * deleted). Undefined when it cannot be undone.
 */
export function undoPatch(entry: HistoryEntry): Record<string, unknown> | undefined {
  if (entry.action === "insert") return { status: "dropped" };
  if (entry.action !== "update" || !entry.before) return undefined;
  const fields = changedFields(entry);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((field) => [field, entry.before![field] ?? null]));
}

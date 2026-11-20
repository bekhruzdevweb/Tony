import "server-only";
import { confirmationFor, savedMarks } from "./brain/checks";
import { unsaved } from "./brain/reliability";
import { runTool } from "./brain/tools";
import { requireDb } from "./db";
import { scheduleReminder } from "./reminders";
import { getRoutine, kindFor, recordSample } from "./routine";
import { typedTime } from "./routine-rules";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addSubtasks, progress, subtasksFor } from "./subtasks";
import { parseLocalDateTime } from "./time";

/**
 * After [✏️ Other time]: the time he typed ("20:30", "8 pm"), placed on that
 * day in plain code, no model call, and learned. Undefined when his words are
 * not just a clear time; then the brain reads them.
 */
export async function placeTypedTime(text: string, slot: { task_id: number; day: string }, now = new Date()): Promise<{ text: string } | undefined> {
  const task = (await requireDb().from("tasks").select().eq("id", slot.task_id).maybeSingle()).data as Task | null;
  const day = parseLocalDateTime(`${slot.day}T12:00`);
  if (!task || !day || !OPEN_STATUSES.includes(task.status)) return undefined;
  const at = typedTime(text, { day, now, routine: await getRoutine(), kind: await kindFor(task) });
  if (!at) return undefined;
  const placed = await placeTask(task.id, at, { learn: true });
  return { text: placed.text };
}

/**
 * What his taps on Tony's proposals do, in plain code (no AI): put a task at
 * the slot he accepted or chose, or carry out the action Tony proposed.
 * Every result is read back from the database before it is confirmed.
 */

/**
 * Puts a task at a time (his ✓ on Tony's slot, or a slot he picked). A slot
 * he picked himself teaches Tony where this kind of task belongs.
 */
export async function placeTask(taskId: number, at: Date, options: { learn?: boolean } = {}): Promise<{ text: string; task?: Task }> {
  const db = requireDb();
  const found = await db.from("tasks").select().eq("id", taskId).maybeSingle();
  const task = found.data as Task | null;
  if (!task) return { text: "That task no longer exists, sir." };
  if (!OPEN_STATUSES.includes(task.status)) return { text: `**${task.title}** is already settled, sir.` };
  if (at.getTime() <= Date.now() - 60_000) return { text: "That time has already passed, sir." };
  const { error } = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo" }).eq("id", taskId);
  if (error) throw new Error(`placeTask: ${error.message}`);
  await scheduleReminder(taskId, at);
  if (options.learn) await recordSample(task, at);
  const back = (await db.from("tasks").select().eq("id", taskId).maybeSingle()).data as Task | null;
  if (!back?.due_at || new Date(back.due_at).getTime() !== at.getTime()) return { text: `⚠️ **${task.title}**: the time did not save, sir.` };
  return { text: confirmationFor([{ tool: "update_task", title: back.title, status: back.status, due_at: back.due_at }], new Date()), task: back };
}

/** The steps he typed after [🧩 Steps] on a task that slipped: its parts, added in code, read back. */
export async function addStepsInCode(taskId: number, steps: string[]): Promise<string> {
  const db = requireDb();
  const task = (await db.from("tasks").select().eq("id", taskId).maybeSingle()).data as Task | null;
  if (!task) return "That task no longer exists, sir.";
  await addSubtasks(taskId, steps);
  const list = (await subtasksFor([taskId])).get(taskId) ?? [];
  const kept = steps.filter((step) => list.some((part) => part.title === step));
  if (kept.length === 0) return `⚠️ **${task.title}**: the steps did not save, sir.`;
  return `☑ **${task.title}** · ${progress(list)} parts\n${list.map((part) => `${part.done ? "☑" : "☐"} ${part.title}`).join("\n")}`;
}

/**
 * His tap on [✂️ Split …]: a long task with no gap for it becomes two halves,
 * "(1/2)" at the first time and "(2/2)" at the second, each with half the
 * length and the same notes and attachments' task kept on the first. Read back.
 */
export async function splitTask(taskId: number, parts: Date[]): Promise<{ text: string }> {
  const db = requireDb();
  const found = await db.from("tasks").select().eq("id", taskId).maybeSingle();
  const task = found.data as Task | null;
  if (!task) return { text: "That task no longer exists, sir." };
  if (!OPEN_STATUSES.includes(task.status)) return { text: `**${task.title}** is already settled, sir.` };
  if (parts.length !== 2 || parts.some((at) => at.getTime() <= Date.now() - 60_000)) return { text: "Those times have already passed, sir." };
  const half = Math.ceil((task.duration_minutes || 60) / 2);
  const base = task.title.replace(/\s*\(\d\/2\)$/, "");
  const first = { title: `${base} (1/2)`, due_at: parts[0].toISOString(), status: "todo", duration_minutes: half };
  const { error } = await db.from("tasks").update(first).eq("id", taskId);
  if (error) throw new Error(`splitTask: ${error.message}`);
  await scheduleReminder(taskId, parts[0]);
  const second = await db
    .from("tasks")
    .insert({ title: `${base} (2/2)`, due_at: parts[1].toISOString(), status: "todo", duration_minutes: half, notes: task.notes, priority: task.priority, project_id: task.project_id, persistent: task.persistent })
    .select()
    .single();
  if (second.error) throw new Error(`splitTask: ${second.error.message}`);
  const other = second.data as Task;
  await scheduleReminder(other.id, parts[1]);
  const rows = ((await db.from("tasks").select().in("id", [taskId, other.id])).data ?? []) as Task[];
  const ok = rows.length === 2 && rows.every((row) => row.due_at && parts.some((at) => new Date(row.due_at!).getTime() === at.getTime()));
  if (!ok) return { text: `⚠️ **${base}**: the split did not save, sir.` };
  return { text: confirmationFor(rows.sort((a, b) => a.due_at!.localeCompare(b.due_at!)).map((row) => ({ tool: "update_task" as const, title: row.title, status: row.status, due_at: row.due_at })), new Date()) };
}

type ActionOffer = {
  kind: string;
  payload: { say: string; tool: string; args: Record<string, unknown>; said?: string | null; heard?: string | null };
  used_at: string | null;
};

/** His ✓ on "I'll remove Buy notebook": the proposed tool call, run now, confirmed from what is stored. */
export async function runProposal(offerId: number, now = new Date()): Promise<string> {
  const db = requireDb();
  const { data } = await db.from("offers").select().eq("id", offerId).maybeSingle();
  const offer = data as ActionOffer | null;
  if (!offer || offer.kind !== "action") return "That proposal has gone, sir.";
  if (offer.used_at) return "Already settled, sir.";
  const { tool, args, said, heard } = offer.payload;
  const outcome = await runTool(tool, args, now, said ?? undefined, heard ?? undefined);
  await db.from("offers").update({ used_at: now.toISOString(), used_as: outcome.ok ? "done" : "failed" }).eq("id", offerId);
  if (!outcome.ok) return `⚠️ That did not work, sir: ${outcome.error}`;
  const taskId = Number((outcome as { task_id?: unknown }).task_id);
  if (Number.isFinite(taskId)) {
    const task = (await db.from("tasks").select().eq("id", taskId).maybeSingle()).data as Task | null;
    if (!task) return "⚠️ That change did not save, sir.";
    const wrote = (outcome as { wrote?: Record<string, unknown> }).wrote;
    const missing = wrote ? unsaved(task as unknown as Record<string, unknown>, wrote) : [];
    if (missing.length) return `⚠️ **${task.title}**: the ${missing.join(" and ")} did not save, sir.`;
    const notes = typeof wrote?.notes === "string" ? wrote.notes : "";
    const name = (tool === "complete_task" ? "complete_task" : tool === "set_reminder" ? "set_reminder" : tool === "add_task" ? "add_task" : "update_task") as "add_task";
    const reminder = (outcome as { reminder_at?: unknown }).reminder_at;
    return confirmationFor(
      [
        {
          tool: name,
          title: task.title,
          status: task.status,
          due_at: task.due_at,
          ...(typeof reminder === "string" ? { reminder_at: reminder } : {}),
          ...(/https?:\/\//.test(notes) ? { link: true } : {}),
          ...(notes.replace(/https?:\/\/\S+/g, "").trim() ? { note: notes } : {}),
        },
      ],
      now,
    );
  }
  const fact = (outcome as { fact?: unknown }).fact;
  if (typeof fact === "string") return `📝 Remembered: ${fact}`;
  return `Done, sir.${savedMarks({})}`;
}

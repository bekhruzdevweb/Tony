import "server-only";
import { requireDb } from "../db";
import { finishTask } from "../recurrence";
import { scheduleReminder, settleReminders } from "../reminders";
import { MAX_TITLE_LENGTH, OPEN_STATUSES, type Task } from "../tasks";
import { addMinutes, dayBounds, formatDue, parseLocalDateTime, toWholeMinute } from "../time";
import type { ToolDefinition } from "./model";
import { taskLine, type ProjectRef } from "./prompt";

const LOCAL_TIME = "Local Tashkent time, YYYY-MM-DDTHH:MM (24-hour).";

const taskFields = {
  title: { type: "string", description: "Short task title, in the user's words, without the time." },
  due_at: { type: "string", description: `When it is due. ${LOCAL_TIME} Omit for an undated inbox task.` },
  project: { type: "string", description: "Project name, only if it clearly fits an existing one." },
  priority: { type: "integer", enum: [1, 2, 3, 4], description: "1 is most urgent, 4 is normal (default)." },
  persistent: { type: "boolean", description: "Keep nudging until he taps Start or Skip." },
  repeat: { type: "string", enum: ["daily", "weekdays", "weekly", "none"], description: "Repeat rule." },
  notes: { type: "string", description: "Extra detail worth keeping." },
};

/** The seven tools from the spec: everything Tony can do. */
export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "add_task",
      description: "Create a task. With due_at it is scheduled and reminded; without, it goes to the inbox.",
      parameters: { type: "object", properties: taskFields, required: ["title"] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "Change a task: rename, reschedule (due_at), move to the inbox (clear_due), set priority, project, persistent, repeat, or drop it (status 'dropped').",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The task number." },
          ...taskFields,
          clear_due: { type: "boolean", description: "Remove the date and put the task back in the inbox." },
          status: { type: "string", enum: ["todo", "dropped", "skipped"], description: "'dropped' deletes the task from his lists." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark a task done and cancel its pending reminders.",
      parameters: { type: "object", properties: { id: { type: "integer", description: "The task number." } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List tasks, filtered by day, status or project.",
      parameters: {
        type: "object",
        properties: {
          day: { type: "string", description: "'today', 'tomorrow', 'overdue' or a date YYYY-MM-DD." },
          status: { type: "string", enum: ["open", "inbox", "done"], description: "Default 'open'." },
          project: { type: "string", description: "Project name." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Add one extra reminder for an existing task at a given time, without changing when it is due.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "integer" }, at: { type: "string", description: LOCAL_TIME } },
        required: ["task_id", "at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a lasting fact or preference the user stated about himself.",
      parameters: { type: "object", properties: { fact: { type: "string", description: "One short sentence." } }, required: ["fact"] },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Delete a saved memory note by its number.",
      parameters: { type: "object", properties: { id: { type: "integer", description: "The note's number in brackets." } }, required: ["id"] },
    },
  },
];

const normaliseTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

type Args = Record<string, unknown>;
type Result = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const fail = (error: string): Result => ({ ok: false, error });

function check(where: string, error: { message: string } | null) {
  if (error) throw new Error(`${where}: ${error.message}`);
}

async function loadProjects(): Promise<ProjectRef[]> {
  const { data, error } = await requireDb().from("projects").select("id, name").order("sort_order");
  check("loadProjects", error);
  return data as ProjectRef[];
}

async function loadTask(id: unknown): Promise<Task | undefined> {
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId)) return undefined;
  const { data, error } = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
  check("loadTask", error);
  return (data as Task | null) ?? undefined;
}

/** Reads the fields shared by add_task and update_task into a row patch. */
async function readFields(args: Args, now: Date): Promise<{ patch: Partial<Task>; dueAt?: Date } | { error: string }> {
  const patch: Partial<Task> = {};
  let dueAt: Date | undefined;

  if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim().slice(0, MAX_TITLE_LENGTH);
  if (typeof args.notes === "string") patch.notes = args.notes.trim() || null;
  if (args.priority !== undefined) {
    const priority = Number(args.priority);
    if (![1, 2, 3, 4].includes(priority)) return { error: "priority must be 1, 2, 3 or 4" };
    patch.priority = priority;
  }
  if (typeof args.persistent === "boolean") patch.persistent = args.persistent;
  if (typeof args.repeat === "string") {
    if (!["daily", "weekdays", "weekly", "none"].includes(args.repeat)) return { error: "repeat must be daily, weekdays, weekly or none" };
    patch.repeat_rule = args.repeat === "none" ? null : (args.repeat as Task["repeat_rule"]);
  }
  if (args.project === "none") {
    patch.project_id = null;
  } else if (typeof args.project === "string" && args.project.trim()) {
    const projects = await loadProjects();
    const match = projects.find((p) => p.name.toLowerCase() === (args.project as string).trim().toLowerCase());
    if (!match) return { error: `no project called "${args.project}". Projects: ${projects.map((p) => p.name).join(", ") || "none"}` };
    patch.project_id = match.id;
  }
  if (typeof args.due_at === "string" && args.due_at.trim()) {
    const parsed = parseLocalDateTime(args.due_at);
    if (!parsed) return { error: `could not read due_at "${args.due_at}"; use YYYY-MM-DDTHH:MM` };
    dueAt = toWholeMinute(parsed);
    if (dueAt.getTime() < now.getTime() - 60_000) {
      return { error: `${formatDue(dueAt, now)} has already passed (now is ${formatDue(now, now)}). Ask him which time he means.` };
    }
    patch.due_at = dueAt.toISOString();
  }
  return { patch, dueAt };
}

/** Runs one tool call. Problems come back as { ok: false }, so the model can tell the user. */
export async function runTool(name: string, args: Args, now = new Date()): Promise<Result> {
  const db = requireDb();
  switch (name) {
    case "add_task": {
      const fields = await readFields(args, now);
      if ("error" in fields) return fail(fields.error);
      if (!fields.patch.title) return fail("title is required");
      // The same task twice is almost always a mistake (and once was: a
      // complaint about a late reminder became a second copy of the task).
      const open = await db.from("tasks").select().in("status", OPEN_STATUSES);
      check("add_task", open.error);
      const wanted = normaliseTitle(fields.patch.title);
      const twin = (open.data as Task[]).find((t) => normaliseTitle(t.title) === wanted);
      if (twin) {
        return fail(
          `task ${taskLine(twin, await loadProjects(), now)} already exists. Do not add it again: use update_task on #${twin.id} if he asked to change it, otherwise just tell him it is already on the list.`,
        );
      }
      const { data, error } = await db
        .from("tasks")
        .insert({ ...fields.patch, status: fields.dueAt ? "todo" : "inbox" })
        .select()
        .single();
      check("add_task", error);
      const task = data as Task;
      if (fields.dueAt) await scheduleReminder(task.id, fields.dueAt);
      return { ok: true, task: taskLine(task, await loadProjects(), now) };
    }

    case "update_task": {
      const task = await loadTask(args.id);
      if (!task) return fail(`no task #${args.id}`);
      const fields = await readFields(args, now);
      if ("error" in fields) return fail(fields.error);
      const patch = fields.patch;

      const status = typeof args.status === "string" ? args.status : undefined;
      if (status && !["todo", "dropped", "skipped"].includes(status)) return fail("status must be todo, dropped or skipped");
      if (status === "skipped" && Object.keys(patch).length === 0) {
        // Skipping a repeating task moves it to its next date instead of closing it.
        const { nextLabel } = await finishTask(task, "skipped", now);
        return { ok: true, task: task.title, status: nextLabel ? `skipped; next one ${nextLabel}` : "skipped" };
      }
      if (status === "dropped" || status === "skipped") {
        patch.status = status;
      } else if (args.clear_due === true) {
        patch.due_at = null;
        patch.status = "inbox";
      } else if (fields.dueAt) {
        patch.status = "todo";
      } else if (status === "todo") {
        patch.status = task.due_at ? "todo" : "inbox";
      }
      if (Object.keys(patch).length === 0) return fail("nothing to change");

      const { data, error } = await db.from("tasks").update(patch).eq("id", task.id).select().single();
      check("update_task", error);
      const updated = data as Task;

      if (!OPEN_STATUSES.includes(updated.status) || args.clear_due === true) await settleReminders(task.id);
      else if (fields.dueAt) await scheduleReminder(task.id, fields.dueAt);
      return { ok: true, task: taskLine(updated, await loadProjects(), now), status: updated.status };
    }

    case "complete_task": {
      const task = await loadTask(args.id);
      if (!task) return fail(`no task #${args.id}`);
      if (task.status === "done") return { ok: true, note: "it was already done", task: task.title };
      const { nextLabel } = await finishTask(task, "done", now);
      return nextLabel ? { ok: true, task: task.title, repeats: `it comes round again ${nextLabel}` } : { ok: true, task: task.title };
    }

    case "list_tasks": {
      const status = typeof args.status === "string" ? args.status : "open";
      let query = db.from("tasks").select();
      if (status === "done") query = query.eq("status", "done");
      else if (status === "inbox") query = query.eq("status", "inbox");
      else query = query.in("status", OPEN_STATUSES);

      const projects = await loadProjects();
      if (typeof args.project === "string" && args.project.trim()) {
        const match = projects.find((p) => p.name.toLowerCase() === (args.project as string).trim().toLowerCase());
        if (!match) return fail(`no project called "${args.project}"`);
        query = query.eq("project_id", match.id);
      }

      if (typeof args.day === "string" && args.day.trim()) {
        const day = args.day.trim().toLowerCase();
        const today = dayBounds(now);
        if (day === "overdue") {
          query = query.lt("due_at", today.start.toISOString());
        } else {
          const anchor =
            day === "today" ? now : day === "tomorrow" ? addMinutes(now, 24 * 60) : parseLocalDateTime(day);
          if (!anchor) return fail(`could not read day "${args.day}"`);
          const bounds = dayBounds(addMinutes(anchor, day.length === 10 ? 12 * 60 : 0));
          query = query.gte("due_at", bounds.start.toISOString()).lt("due_at", bounds.end.toISOString());
        }
      }

      const { data, error } = await query.order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(40);
      check("list_tasks", error);
      const tasks = data as Task[];
      return { ok: true, count: tasks.length, tasks: tasks.map((t) => taskLine(t, projects, now)) };
    }

    case "set_reminder": {
      const task = await loadTask(args.task_id);
      if (!task) return fail(`no task #${args.task_id}`);
      if (!OPEN_STATUSES.includes(task.status)) return fail(`"${task.title}" is already ${task.status}`);
      const parsed = typeof args.at === "string" ? parseLocalDateTime(args.at) : undefined;
      if (!parsed) return fail(`could not read at "${args.at}"; use YYYY-MM-DDTHH:MM`);
      const at = toWholeMinute(parsed);
      if (at.getTime() < now.getTime() - 60_000) return fail(`${formatDue(at, now)} has already passed`);
      const { error } = await db.from("reminders").insert({ task_id: task.id, fire_at: at.toISOString(), kind: "extra", attempt: 0 });
      check("set_reminder", error);
      return { ok: true, task: task.title, reminder_at: formatDue(at, now) };
    }

    case "remember": {
      const fact = typeof args.fact === "string" ? args.fact.trim().slice(0, 300) : "";
      if (!fact) return fail("fact is required");
      const { data, error } = await db.from("memory").insert({ fact, source: "user" }).select("id").single();
      check("remember", error);
      return { ok: true, id: (data as { id: number }).id, fact };
    }

    case "forget": {
      const id = Number(args.id);
      if (!Number.isSafeInteger(id)) return fail("id must be a memory note number");
      const { data, error } = await db.from("memory").delete().eq("id", id).select("fact");
      check("forget", error);
      const removed = data as { fact: string }[];
      return removed.length ? { ok: true, forgot: removed[0].fact } : fail(`no memory note [${id}]`);
    }

    default:
      return fail(`unknown tool ${name}`);
  }
}

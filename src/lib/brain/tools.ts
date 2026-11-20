import "server-only";
import { requireDb } from "../db";
import { findMedia, updateMedia } from "../media";
import { buildPlan } from "../planner";
import { finishTask } from "../recurrence";
import { getSettings } from "../settings";
import { scheduleReminder, settleReminders } from "../reminders";
import { MAX_TITLE_LENGTH, OPEN_STATUSES, type Task } from "../tasks";
import { addMinutes, dayBounds, formatDue, parseLocalDateTime, toWholeMinute } from "../time";
import type { ToolDefinition } from "./model";
import { taskLine, type ProjectRef } from "./prompt";
import { decideReminder, findLink, givesTime, isDuplicateReminder, isLinkTask, isOverdue } from "./checks";
import { fetchTitle } from "../links";
import { estimateMinutes } from "../schedule";
import { heldToGivenTime } from "./reliability";
import { addSubtasks, allDone, findSubtask, progress, removeSubtask, setSubtaskDone, subtasksFor } from "../subtasks";

const TIME = "YYYY-MM-DDTHH:MM";
/** Lets the model confirm in the same call, so most messages need one model call, not two. */
const reply = { type: "string", description: "What to tell him on success." };
const id = { type: "integer" };
/** Ties the last photo or file he shared to the task, so its reminder sends the original back. */
const attach = { type: "boolean", description: "Attach the last photo/file he shared." };

const taskFields = {
  title: { type: "string", description: "Short: 2-6 words, without the time, never a link or a question." },
  due_at: { type: "string", description: TIME },
  project: { type: "string" },
  priority: { type: "integer", description: "1 urgent to 4 normal" },
  persistent: { type: "boolean" },
  repeat: { type: "string", enum: ["daily", "weekdays", "weekly", "none"] },
  notes: { type: "string", description: "Description: links, details, anything that would make the title long." },
  duration: { type: "integer", description: "Minutes it takes: his figure, or your estimate" },
};

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

/** The seven tools from the spec: everything Tony can do. */
export const TOOLS: ToolDefinition[] = [
  tool(
    "add_task",
    "Create a task.",
    { ...taskFields, subtasks: { type: "array", items: { type: "string" }, description: "Its parts, when his request lists them (\"stories about X, Y and Z\" → X, Y, Z)" }, attach_shared: attach, reply },
    ["title"],
  ),
  tool(
    "subtask",
    "Add, tick, untick or remove a task's parts (subtasks).",
    {
      task_id: id,
      action: { type: "string", enum: ["add", "tick", "untick", "remove"] },
      titles: { type: "array", items: { type: "string" }, description: "For add: the new parts. For the others: the part, as he named it." },
    },
    ["task_id", "action", "titles"],
  ),
  tool(
    "update_task",
    "Change or drop a task.",
    {
      id,
      ...taskFields,
      clear_due: { type: "boolean", description: "Back to inbox." },
      status: { type: "string", enum: ["todo", "dropped", "skipped"] },
      attach_shared: attach,
      reply,
    },
    ["id"],
  ),
  tool("complete_task", "Mark a task done.", { id, reply }, ["id"]),
  tool(
    "list_tasks",
    "List tasks.",
    {
      day: { type: "string", description: "today|tomorrow|overdue|YYYY-MM-DD" },
      status: { type: "string", enum: ["open", "inbox", "done"] },
      project: { type: "string" },
    },
    [],
  ),
  tool(
    "set_reminder",
    "A reminder for a task at a time. Before the task's time: an extra heads-up. At or after it (or for an undated task): the task moves to that time.",
    { task_id: id, at: { type: "string", description: TIME }, reply },
    ["task_id", "at"],
  ),
  tool(
    "remember",
    "Save a lasting fact about him (a project, goal, person, preference, habit). One fact per call, as a short line he would agree with.",
    { fact: { type: "string" }, reply },
    ["fact"],
  ),
  // "Save this" with a link: saved at once as a bookmark, with a proper title. Nothing is asked.
  tool(
    "save_link",
    "Save a link as a bookmark right away (his \"save this\"). With no url, the link in his message or in the last thing he shared is used.",
    { url: { type: "string" }, title: { type: "string", description: "Only if you know the page's real title" } },
    [],
  ),
  // Talk mode: suggests a task without creating it. He gets a [➕ Make this a task] button; only his tap creates it.
  tool(
    "offer_task",
    "In conversation, when something he said sounds actionable, offer it as a task instead of creating it. Creates nothing.",
    {
      title: { type: "string", description: "Short task title" },
      due_at: { type: "string", description: "YYYY-MM-DDTHH:MM, only if he named a time" },
      reply: { type: "string", description: "Your conversational reply; the button is added below it" },
    },
    ["title", "reply"],
  ),
  tool("forget", "Delete a memory note.", { id: { type: "integer" }, reply }, ["id"]),
  // Agent mode: not in the spec's seven. Tony proposes; nothing changes until the plan is applied.
  tool(
    "plan",
    "Propose a schedule for the overdue and inbox tasks in free slots. He sees it with Apply and Adjust.",
    {
      scope: { type: "string", enum: ["day", "week"] },
      day: { type: "string", description: "today|tomorrow|YYYY-MM-DD (first day)" },
      instructions: { type: "string", description: "His wishes for this plan, if any." },
    },
    ["scope"],
  ),
  tool(
    "media",
    "Saved photos and files: 'note' files the last one he shared under a label (e.g. video idea); 'find' sends back the ones matching the text.",
    { action: { type: "string", enum: ["note", "find"] }, text: { type: "string" }, reply },
    ["action", "text"],
  ),
  tool(
    "ask",
    "Ask him a question with tappable answers.",
    { question: { type: "string" }, options: { type: "array", items: { type: "string" }, description: "2-4 short likely answers." } },
    ["question", "options"],
  ),
];

/** Whether his words name this task (a shared word of five letters or more, by its first five). */
const mentions = (said: string, title: string) => {
  const stems = (text: string) => new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).map((word) => word.slice(0, 5)));
  const his = stems(said);
  return [...stems(title)].some((stem) => his.has(stem));
};

/** The fields a write meant to store, as they should read back. */
const written = (patch: Partial<Task>): Record<string, unknown> => {
  const keep: Record<string, unknown> = {};
  for (const field of ["title", "notes", "due_at", "status", "priority", "project_id", "duration_minutes"] as const) if (field in patch) keep[field] = patch[field];
  return keep;
};

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
async function readFields(args: Args, now: Date, said?: string): Promise<{ patch: Partial<Task>; dueAt?: Date } | { error: string }> {
  const patch: Partial<Task> = {};
  let dueAt: Date | undefined;

  if (typeof args.notes === "string") patch.notes = args.notes.trim() || null;
  if (typeof args.title === "string" && args.title.trim()) {
    // Links belong in the description, never in the title.
    const links = args.title.match(/https?:\/\/\S+|\b[\w-]+(\.[\w-]+)+\.(app|com|org|net|io|uz|ru|dev|me)(\/\S*)?/gi) ?? [];
    let title = args.title;
    for (const link of links) title = title.replace(link, " ");
    title = title.replace(/\s+(at|on|from|via|:)\s*$/i, "").replace(/\s{2,}/g, " ").trim();
    if (links.length) {
      const urls = links.map((link) => (/^https?:/i.test(link) ? link : `https://${link}`));
      patch.notes = [patch.notes, ...urls.filter((url) => !patch.notes?.includes(url))].filter(Boolean).join("\n");
    }
    patch.title = (title || args.title.trim()).slice(0, MAX_TITLE_LENGTH);
  }
  if (args.priority !== undefined) {
    const priority = Number(args.priority);
    if (![1, 2, 3, 4].includes(priority)) return { error: "priority must be 1, 2, 3 or 4" };
    patch.priority = priority;
  }
  if (typeof args.persistent === "boolean") patch.persistent = args.persistent;
  if (args.duration === null || args.duration === 0) patch.duration_minutes = null;
  else if (args.duration !== undefined) {
    const minutes = Math.round(Number(args.duration));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return { error: "duration must be minutes, 1 to 1440" };
    patch.duration_minutes = minutes;
  }
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
    // The time he named is final: if the model picked another, his stands.
    if (said) dueAt = heldToGivenTime(dueAt, said, now) ?? dueAt;
    if (dueAt.getTime() < now.getTime() - 60_000) {
      return { error: `${formatDue(dueAt, now)} has already passed (now is ${formatDue(now, now)}). Ask him which time he means.` };
    }
    patch.due_at = dueAt.toISOString();
  }
  return { patch, dueAt };
}

/** Links the last thing he shared to a task, if asked to and there is one. Returns a note for the model. */
async function attachShared(args: Args, taskId: number): Promise<string | undefined> {
  if (args.attach_shared !== true) return undefined;
  const { last_shared_media_id } = await getSettings();
  if (!last_shared_media_id) return "nothing was attached: he has not shared a photo or file recently";
  // A voice note is never attached: a reminder must not play his own voice back to him.
  const shared = await requireDb().from("media").select("kind").eq("id", last_shared_media_id).maybeSingle();
  const kind = (shared.data as { kind?: string } | null)?.kind;
  if (kind === "voice" || kind === "audio") return "nothing was attached: voice notes are not attached to tasks";
  await updateMedia(Number(last_shared_media_id), { task_id: taskId });
  return "his photo/file is attached; the reminder will send the original back to him";
}

/** Runs one tool call. Problems come back as { ok: false }, so the model can tell the user. */
export async function runTool(name: string, args: Args, now = new Date(), said?: string): Promise<Result> {
  const db = requireDb();
  switch (name) {
    case "add_task": {
      const fields = await readFields(args, now, said);
      if ("error" in fields) return fail(fields.error);
      if (!fields.patch.title) return fail("title is required");
      // A saved link or note gets no date unless his own words gave one: it goes to the inbox.
      if (fields.dueAt && said !== undefined && isLinkTask(fields.patch.title, fields.patch.notes) && !givesTime(said)) {
        fields.dueAt = undefined;
        delete fields.patch.due_at;
      }
      // The same task twice is almost always a mistake (and once was: a
      // complaint about a late reminder became a second copy of the task).
      const open = await db.from("tasks").select().in("status", OPEN_STATUSES);
      check("add_task", open.error);
      const wanted = normaliseTitle(fields.patch.title);
      const twin = (open.data as Task[]).find((t) => normaliseTitle(t.title) === wanted);
      // Every task gets a length: his, the model's estimate, or a guess from the title.
      if (fields.patch.duration_minutes === undefined) fields.patch.duration_minutes = estimateMinutes(fields.patch.title);
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
      // Its parts, as subtasks (never as a list in the notes).
      const parts = Array.isArray(args.subtasks) ? args.subtasks.map(String).filter((t) => t.trim()) : [];
      if (parts.length) await addSubtasks(task.id, parts);
      const attached = await attachShared(args, task.id);
      // What was meant to be written, so it is read back before Tony confirms it.
      return { ok: true, task_id: task.id, task: taskLine(task, await loadProjects(), now), wrote: written(fields.patch), ...(attached ? { attached } : {}) };
    }

    case "update_task": {
      const task = await loadTask(args.id);
      if (!task) return fail(`no task #${args.id}`);
      // His time holds for the task his words are about ("move IELTS prep to 10:00"), not for another one he moved alongside.
      const fields = await readFields(args, now, said && mentions(said, task.title) ? said : undefined);
      if ("error" in fields) return fail(fields.error);
      const patch = fields.patch;

      const status = typeof args.status === "string" ? args.status : undefined;
      if (status && !["todo", "dropped", "skipped"].includes(status)) return fail("status must be todo, dropped or skipped");
      if (status === "skipped" && Object.keys(patch).length === 0) {
        // Skipping a repeating task moves it to its next date instead of closing it.
        const { nextLabel } = await finishTask(task, "skipped", now);
        return { ok: true, task_id: task.id, task: task.title, status: nextLabel ? `skipped; next one ${nextLabel}` : "skipped" };
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
      if (Object.keys(patch).length === 0 && args.attach_shared === true) {
        return { ok: true, task_id: task.id, task: taskLine(task, await loadProjects(), now), attached: await attachShared(args, task.id) };
      }
      if (Object.keys(patch).length === 0) return fail("nothing to change");

      const { data, error } = await db.from("tasks").update(patch).eq("id", task.id).select().single();
      check("update_task", error);
      const updated = data as Task;

      if (!OPEN_STATUSES.includes(updated.status) || args.clear_due === true) await settleReminders(task.id);
      else if (fields.dueAt) await scheduleReminder(task.id, fields.dueAt);
      const attached = await attachShared(args, task.id);
      return { ok: true, task_id: task.id, task: taskLine(updated, await loadProjects(), now), status: updated.status, wrote: written(patch), ...(attached ? { attached } : {}) };
    }

    case "complete_task": {
      const task = await loadTask(args.id);
      if (!task) return fail(`no task #${args.id}`);
      if (task.status === "done") return { ok: true, task_id: task.id, note: "it was already done", task: task.title };
      const { nextLabel } = await finishTask(task, "done", now);
      return nextLabel ? { ok: true, task_id: task.id, task: task.title, repeats: `it comes round again ${nextLabel}` } : { ok: true, task_id: task.id, task: task.title };
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
        if (day === "overdue") {
          // Everything past its time (earlier today too); the shared rule below drops started tasks and prayers.
          query = query.lt("due_at", now.toISOString());
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
      const wantOverdue = typeof args.day === "string" && args.day.trim().toLowerCase() === "overdue";
      const tasks = (data as Task[]).filter((t) => t.kind !== "prayer" && (!wantOverdue || isOverdue(t, now)));
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
      const decision = decideReminder(task.due_at ? new Date(task.due_at) : null, at);
      if (decision === "move") {
        // A reminder after the task's time (or for an undated task) is a reschedule: the task itself moves.
        const moved = await db.from("tasks").update({ due_at: at.toISOString(), status: task.status === "inbox" ? "todo" : task.status }).eq("id", task.id);
        check("set_reminder", moved.error);
        await scheduleReminder(task.id, at);
        return { ok: true, task_id: task.id, task: task.title, moved_to: formatDue(at, now), wrote: { due_at: at.toISOString() } };
      }
      if (decision === "same") return { ok: true, task_id: task.id, task: task.title, note: "it is already set for that time" };
      // A heads-up before the task's time, unless one is already waiting at that minute.
      const waiting = await db.from("reminders").select("fire_at").eq("task_id", task.id).eq("state", "scheduled");
      check("set_reminder", waiting.error);
      if (!isDuplicateReminder((waiting.data ?? []) as { fire_at: string }[], at)) {
        const { error } = await db.from("reminders").insert({ task_id: task.id, fire_at: at.toISOString(), kind: "extra", attempt: 0 });
        check("set_reminder", error);
      }
      return { ok: true, task_id: task.id, task: task.title, reminder_at: at.toISOString() };
    }

    case "remember": {
      const fact = typeof args.fact === "string" ? args.fact.trim().slice(0, 300) : "";
      if (!fact) return fail("fact is required");
      // Already known (same words, any case): nothing to add.
      const known = await db.from("memory").select("id, fact").ilike("fact", fact.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1);
      if (!known.error && (known.data ?? []).length > 0) return { ok: true, id: (known.data as { id: number }[])[0].id, fact, already_known: true };
      const { data, error } = await db.from("memory").insert({ fact, source: "user" }).select("id").single();
      check("remember", error);
      return { ok: true, id: (data as { id: number }).id, fact };
    }

    case "subtask": {
      const task = await loadTask(args.task_id);
      if (!task) return fail(`no task #${args.task_id}`);
      const titles = Array.isArray(args.titles) ? args.titles.map(String).filter((t) => t.trim()) : [];
      if (titles.length === 0) return fail("titles are required");
      if (args.action === "add") {
        const all = await addSubtasks(task.id, titles);
        return { ok: true, task_id: task.id, task: task.title, subtasks: progress(all) };
      }
      const current = (await subtasksFor([task.id])).get(task.id) ?? [];
      const missing: string[] = [];
      let after = current;
      for (const words of titles) {
        const part = findSubtask(after, words);
        if (!part) {
          missing.push(words);
          continue;
        }
        if (args.action === "remove") await removeSubtask(part.id);
        else after = (await setSubtaskDone(part.id, args.action === "tick"))?.subtasks ?? after;
        if (args.action === "remove") after = after.filter((s) => s.id !== part.id);
      }
      if (missing.length === titles.length) return fail(`"${task.title}" has no part called ${missing.map((m) => `"${m}"`).join(", ")}; its parts are ${current.map((s) => s.title).join(", ") || "none"}`);
      return { ok: true, task_id: task.id, task: task.title, subtasks: progress(after), all_done: allDone(after) };
    }

    case "save_link": {
      const settings = await getSettings();
      const url = findLink(typeof args.url === "string" ? args.url : "", settings.last_shared_text);
      if (!url) return fail("there is no link in his message or in what he shared recently");
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 120) : await fetchTitle(url);
      const fact = `Saved link: ${title} (${url})`.slice(0, 300);
      const known = await db.from("memory").select("id").eq("fact", fact).limit(1);
      if (!known.error && (known.data ?? []).length === 0) {
        const { error } = await db.from("memory").insert({ fact, source: "link" });
        check("save_link", error);
      }
      return { ok: true, saved: title, url };
    }

    case "offer_task": {
      const title = typeof args.title === "string" ? args.title.trim().slice(0, 200) : "";
      if (!title) return fail("title is required");
      const due = typeof args.due_at === "string" && args.due_at.trim() ? parseLocalDateTime(args.due_at.trim()) : undefined;
      const { data, error } = await db
        .from("offers")
        .insert({ kind: "task", payload: { title, ...(due ? { due_at: due.toISOString() } : {}) } })
        .select("id")
        .single();
      check("offer_task", error);
      return { ok: true, offer_id: (data as { id: number }).id, offered: title };
    }

    case "forget": {
      const id = Number(args.id);
      if (!Number.isSafeInteger(id)) return fail("id must be a memory note number");
      const { data, error } = await db.from("memory").delete().eq("id", id).select("fact");
      check("forget", error);
      const removed = data as { fact: string }[];
      return removed.length ? { ok: true, id, forgot: removed[0].fact } : fail(`no memory note [${id}]`);
    }

    case "plan": {
      const scope = args.scope === "week" ? "week" : "day";
      const dayText = typeof args.day === "string" ? args.day.trim().toLowerCase() : "today";
      const day = dayText === "tomorrow" ? addMinutes(now, 24 * 60) : dayText === "today" || !dayText ? now : parseLocalDateTime(dayText);
      if (!day) return fail(`could not read day "${args.day}"`);
      const result = await buildPlan({ scope, day, now, instructions: typeof args.instructions === "string" ? args.instructions.slice(0, 300) : undefined });
      if ("nothing" in result) return fail(result.nothing);
      return { ok: true, plan_id: result.plan.id, placed: result.plan.items.length, left_out: result.plan.left_out.length };
    }

    case "media": {
      const text = typeof args.text === "string" ? args.text.trim().slice(0, 200) : "";
      if (!text) return fail("text is required");
      if (args.action === "note") {
        const { last_shared_media_id } = await getSettings();
        if (!last_shared_media_id) return fail("he has not shared a photo or file recently");
        await updateMedia(Number(last_shared_media_id), { note: text });
        return { ok: true, saved_as: text };
      }
      const found = await findMedia(text);
      if (found.length === 0) return fail(`nothing saved matches "${text}"`);
      return { ok: true, media_ids: found.map((item) => item.id), count: found.length };
    }

    case "ask": {
      const question = typeof args.question === "string" ? args.question.trim().slice(0, 300) : "";
      const options = Array.isArray(args.options) ? args.options.map((option) => String(option).trim().slice(0, 40)).filter(Boolean).slice(0, 4) : [];
      if (!question || options.length < 2) return fail("ask needs a question and at least two options");
      return { ok: true, question, options };
    }

    default:
      return fail(`unknown tool ${name}`);
  }
}

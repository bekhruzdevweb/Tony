import "server-only";
import { requireDb } from "../db";
import { higherLayer, readLayer, type MemoryLayer } from "../memory-rules";
import { attachmentCounts, findMedia, mediaLabel, needsReading, rereadDocument, updateMedia } from "../media";
import { buildPlan } from "../planner";
import { finishTask } from "../recurrence";
import { getSettings } from "../settings";
import { scheduleReminder, settleReminders } from "../reminders";
import { ANYTIME_HOUR, MAX_TITLE_LENGTH, OPEN_STATUSES, URGENT_LADDER, type Task } from "../tasks";
import { addMinutes, dayBounds, formatDue, parseLocalDateTime, toWholeMinute } from "../time";
import type { ToolDefinition } from "./model";
import { taskLine, type ProjectRef } from "./prompt";
import { decideReminder, findLink, givesTime, isDuplicateReminder, isLinkTask, isOverdue } from "./checks";
import { fetchTitle } from "../links";
import { attachItem, findInLibrary, forgetItem, itemRef, loadItem, saveToLibrary } from "../library";
import { itemLabel, type LibraryItem } from "../library-rules";
import { addRule, deleteRule, fireRule } from "../rules";
import { isFreeTimeRequest } from "../smart-rules";
import { dayFromText, estimateMinutes } from "../schedule";
import { givenTimes, heldToGivenTime, hisTitle, mergeNotes, nightTomorrow, ownWords, statedByHim, type GivenTime } from "./reliability";
import { checkInDays, checkInTime, ROUTINE_FIELDS } from "../routine-rules";
import { getRoutine, recordSample, setAutoKinds, setRoutineField } from "../routine";
import { isNight, localDate, minuteOfDay } from "../time";
import { startDate } from "../smart-inbox-rules";
import { addSubtasks, allDone, findSubtask, progress, removeSubtask, setSubtaskDone, subtasksFor } from "../subtasks";
import { normalTag, normalTags, prefixTag, tagsFor } from "../tags";
import { namesDay } from "./checks";
import { habitFor, isHabit, streakLine } from "../habits";

const TIME = "YYYY-MM-DDTHH:MM";
/** What Tony says as himself with the action, shown above the receipt Tony's code adds (Phase 2): one model call, his own words kept. */
const reply = { type: "string", description: "What you say to him as yourself, shown above the receipt line Tony adds: a comment, advice or a joke, or empty for a plain request. Never the action, the title, the time or the date: the receipt shows those." };
const id = { type: "integer" };
/** Ties the last photo or file he shared to the task, so its reminder sends the original back. */
const attach = { type: "boolean", description: "Attach the last photo/file he shared." };

const taskFields = {
  title: { type: "string", description: "Short: 2-6 words, without the time, never a link or a question." },
  due_at: { type: "string", description: TIME },
  project: { type: "string" },
  priority: { type: "integer", description: "1 urgent (must be done that day: Tony chases it 15 min after its time, then hourly until he answers or it is done), 2 important, 4 normal (the default)" },
  anytime: { type: "boolean", description: "A small thing with no time on its day (\"clean my room\", \"quick\", \"no need for a time\", \"anytime today\", tasks of 5-15 min): with day (or none: today). No time is asked or shown; one quiet check at 20:00 if still open." },
  persistent: { type: "boolean" },
  repeat: { type: "string", enum: ["daily", "weekdays", "weekly", "none"] },
  repeat_until: { type: "string", description: "YYYY-MM-DD: the last day a repeating task comes round (a plan's end date)" },
  notes: { type: "string", description: "Description: links, details, anything that would make the title long." },
  duration: { type: "integer", description: "Minutes it takes: his figure, or your estimate" },
  day: { type: "string", description: "YYYY-MM-DD: a day he named WITHOUT a time. Leave due_at out; Tony picks or offers the time from his routine." },
  pick_time: {
    type: "boolean",
    description: "With day: he says \"you choose\" / \"pick a time for me\" for a real task that needs a slot. Tony picks the best free time that day himself. For a small thing that needs no time at all, use anytime instead.",
  },
  nudge_after_days: { type: "integer", description: "\"Remind me if I don't check it for N days\": N. A check-in comes if the task sits untouched that long." },
  free_time: { type: "boolean", description: "\"In my free time\", \"someday\", \"when I'm free\": the 🌙 Free Time list, no date and no day." },
  habit: { type: "boolean", description: "A habit he wants to build (\"make reading a daily habit\", \"I want to stretch every morning\"): streaks and check-ins. Never a plan's sessions or a chore." },
  tags: { type: "array", items: { type: "string" }, description: "His themes, without #: the ones he names (\"#content\", \"tag it ielts\"). On update_task: the full list after the change." },
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
      tag: { type: "string", description: "Tasks with this tag (\"content\" for \"my content tasks\")" },
      habits: { type: "boolean", description: "Only his habits" },
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
    "Keep something about him, in one short line in his words, in the right layer. week: true now (this week's plans, focus, goals). month: holds for weeks (a monthly goal, a project under way). always: who he is, his people, preferences, routine, how he wants you to work. When he repeats or confirms a note already in Memory, pass same_as with its number: it counts as confirmed and can move up a layer.",
    {
      fact: { type: "string" },
      layer: { type: "string", enum: ["week", "month", "always"] },
      goal: { type: "boolean", description: "A goal he set himself (\"get IELTS 7.5\", \"post a reel every day this week\")" },
      same_as: { type: "integer", description: "The number of the Memory note he repeated or confirmed" },
      reply,
    },
    [],
  ),
  // "Save this" with a link: saved at once as a bookmark, with a proper title. Nothing is asked.
  tool(
    "save_link",
    "Save a link as a bookmark right away (his \"save this\"). With no url, the link in his message or in the last thing he shared is used.",
    { url: { type: "string" }, title: { type: "string", description: "Only if you know the page's real title" } },
    [],
  ),
  tool(
    "routine",
    "Save part of his routine when he tells it: his hours for teaching, content, coding or workouts (\"Mon-Fri 14:00-18:00\", \"10:00-12:00\"), when he wakes or sleeps (\"07:00\"), his free days (\"Sun\"). Every scheduling decision uses it. Never guess it. Field \"decide\": only when he explicitly says \"decide yourself for <kind>\" (on) or \"ask me again for <kind>\" (on false); value is the kind in his words (\"podcasts and videos\").",
    {
      field: { type: "string", enum: [...ROUTINE_FIELDS, "decide"] },
      value: { type: "string", description: "As he said it, e.g. \"Mon-Fri 14:00-18:00\", \"none\" to clear; for decide, the kind of task in his words" },
      on: { type: "boolean", description: "decide only: true for \"decide yourself\", false for \"ask me again\"" },
    },
    ["field", "value"],
  ),
  // Instead of a question he may not follow: say what will happen; he taps ✓ (done in code) or ✏️.
  tool(
    "propose",
    "When you are not sure what he wants, say what you will do and let him confirm with ✓ or change it with ✏️, instead of asking him a question. Nothing changes until he taps ✓.",
    {
      say: { type: "string", description: "What you will do, in one short sentence: \"I'll remove **Buy notebook**.\"" },
      tool: { type: "string", enum: ["add_task", "update_task", "complete_task", "set_reminder", "subtask", "remember"] },
      args: { type: "object", description: "The arguments for that tool, exactly as you would call it." },
    },
    ["say", "tool", "args"],
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
      all: { type: "boolean", description: "He wants every waiting task placed (\"schedule all the tasks\", \"add them anyway\", \"the ones you didn't add too\"): no limit per day; only what has no free time is left out." },
    },
    ["scope"],
  ),
  tool(
    "media",
    "Saved photos and files: 'note' files the last one he shared under a label (e.g. video idea); 'find' lists saved files matching the text (to send one, use library send).",
    { action: { type: "string", enum: ["note", "find"] }, text: { type: "string" }, reply },
    ["action", "text"],
  ),
  // The library: every link, post, photo, video, file and voice note he sent, found by what he calls it.
  tool(
    "library",
    "His library: everything he sent (links, posts, photos, videos, files, voice notes), listed below with what he said when he sent each. send: send him items (\"send me the link\", \"the reel\", \"that photo\"): Tony sends the exact link or file; never type a link yourself. A task's whole material (\"send it as a preview\", \"send both\", \"what did I save for it\"): items [\"task:<id>\"], and Tony sends its photos and videos together in one album. read: the full text Tony read from a saved PDF, text file or photo (to answer what it says). find: search older items not in the list. attach: put an item on a task (a file is attached, a link goes into its notes). forget: delete an item for good, only when he asks (\"forget this pdf\", \"delete that video\"); never say you cannot.",
    {
      action: { type: "string", enum: ["send", "read", "find", "attach", "forget"] },
      items: { type: "array", items: { type: "string" }, description: "send: exactly the item(s) he asked for, e.g. [\"library:3\"]: one, unless he asked for several; [\"task:12\"] for everything kept with task 12" },
      text: { type: "string", description: "His words for the item" },
      item: { type: "string", description: "An item from find or the Library list below, e.g. \"library:3\" or \"media:7\"" },
      task_id: { type: "integer", description: "attach: the task" },
      from: { type: "integer", description: "read: where to start in a long document (the next_from it gave)" },
    },
    ["action"],
  ),
  // Situation rules: "when I'm not motivated to work out, send me this video".
  tool(
    "rule",
    "His rules, \"when X, do Y\". add: save one (situation in his words, what to do, and attach \"last\" for the thing he just shared, or a library item). delete: remove one he asks to remove. list: his rules (Tony shows them with buttons).",
    {
      action: { type: "string", enum: ["add", "delete", "list"] },
      situation: { type: "string", description: "In his words: \"I'm not motivated to work out\"" },
      do: { type: "string", description: "What to do then: \"send me the workout video\"" },
      attach: { type: "string", description: "\"last\" (what he just shared) or a library item (\"media:7\")" },
      id: { type: "integer" },
    },
    ["action"],
  ),
  tool(
    "rule_fire",
    "His message fits one of his rules (listed below): act on it. Tony sends the rule's item; your reply is the empathy and a helpful offer.",
    { id: { type: "integer" }, reply },
    ["id"],
  ),
  // His main priority (22 Nov): the one thing chased until it is done.
  tool(
    "main_priority",
    "His main priority (⭐ in the list): the one thing he must finish. Tony chases it in code until it is done: a nudge every 30 minutes from half an hour after its time, hourly when he does not answer, never at night, at most 8 a day. set: the task's id, or the ids of one plan's sessions (then one is chased each day); setting one replaces the last. clear: he no longer wants it chased.",
    {
      action: { type: "string", enum: ["set", "clear"] },
      task_ids: { type: "array", items: { type: "integer" } },
      add: { type: "boolean", description: "He wants this one as well as the main priority he already has (\"also\", \"both\"): the others stay." },
      reply,
    },
    ["action"],
  ),
  tool(
    "ask",
    "Ask him a question with tappable answers.",
    { question: { type: "string" }, options: { type: "array", items: { type: "string" }, description: "2-4 short likely answers." } },
    ["question", "options"],
  ),
];

/** What Tony may propose and do on his ✓. */
/** His message is a yes to the question Tony just asked ("Yes, remove them all", "ha", "ok do it"). */
export function answersYes(said: string, heard: string): boolean {
  if (!heard.includes("?")) return false;
  const words = said.trim().toLowerCase();
  if (words.length > 60 || /\b(no|not|don'?t|wait|but|except|only|instead|yo'?q|net)\b/.test(words)) return false;
  return /^(yes|yeah|yep|yup|ok|okay|sure|of course|please|do it|go ahead|confirm(ed)?|ha|xa|mayli|da|kerak|(remove|delete|drop) (them|it|all|both|those|these|everything))\b/.test(words);
}

const PROPOSABLE = new Set(["add_task", "update_task", "complete_task", "set_reminder", "subtask", "remember", "forget", "rule", "routine", "library"]);

/** Whether his words name this task (a shared word of five letters or more, by its first five). */
const mentions = (said: string, title: string) => {
  const stems = (text: string) => new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []).map((word) => word.slice(0, 5)));
  const his = stems(said);
  return [...stems(title)].some((stem) => his.has(stem));
};

/** The fields a write meant to store, as they should read back. */
const written = (patch: Partial<Task>): Record<string, unknown> => {
  const keep: Record<string, unknown> = {};
  for (const field of ["title", "notes", "due_at", "status", "priority", "project_id", "duration_minutes", "habit", "tags"] as const) if (field in patch) keep[field] = patch[field];
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
/** Whether the model's time is one of the times in these words. */
const matchesTime = (times: GivenTime[], at: Date) =>
  times.some((time) => ("at" in time ? Math.abs(time.at.getTime() - at.getTime()) <= 2 * 60_000 : time.minutes.includes(minuteOfDay(at))));

/** Where the words a time may come from: his message, and what he is answering (Tony's last message, a post he shared). */
export type Heard = {
  said?: string;
  heard?: string;
  /** His time is applied to this task (his words are about it), correcting the model's. */
  hold?: boolean;
};

async function readFields(
  args: Args,
  now: Date,
  words: Heard = {},
  existingDue?: string | null,
): Promise<{ patch: Partial<Task>; dueAt?: Date; dayOnly?: string } | { error: string }> {
  const patch: Partial<Task> = {};
  let dueAt: Date | undefined;
  let dayOnly: string | undefined;
  const { said, heard, hold = true } = words;

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
    const named = typeof args.priority === "string" ? ({ urgent: 1, important: 2, normal: 4 } as Record<string, number>)[args.priority.toLowerCase()] : undefined;
    const priority = named ?? Number(args.priority);
    if (![1, 2, 3, 4].includes(priority)) return { error: "priority must be urgent (1), important (2) or normal (4)" };
    patch.priority = priority;
    // Urgent is chased that day (23 Nov): 15 minutes after its time, then hourly, until he answers or it is done.
    if (priority === 1 && args.persistent !== false) {
      patch.persistent = true;
      patch.persistent_schedule = URGENT_LADDER;
    } else if (priority !== 1 && args.persistent === undefined) {
      patch.persistent = false;
      patch.persistent_schedule = null;
    }
  }
  if (typeof args.persistent === "boolean") patch.persistent = args.persistent;
  if (typeof args.habit === "boolean") patch.habit = args.habit;
  if (Array.isArray(args.tags)) patch.tags = normalTags(args.tags);
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
  if (typeof args.repeat_until === "string" && args.repeat_until.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.repeat_until.trim())) return { error: "repeat_until must be YYYY-MM-DD" };
    patch.repeat_until = args.repeat_until.trim();
  } else if (args.repeat === "none") patch.repeat_until = null;
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
    // After midnight, "tomorrow" is the day after he sleeps: a date the model put a day later comes back.
    // Only the words he typed count as his; a forwarded post or a photo's text is material (21 Nov).
    const typed = said !== undefined ? ownWords(said) : undefined;
    if (typed !== undefined) dueAt = nightTomorrow(dueAt, typed, now) ?? dueAt;
    if (typed !== undefined && said !== undefined) {
      const his = givenTimes(typed, now);
      if (his.length === 1 && hold) {
        // The time he named is final: if the model picked another, his stands.
        dueAt = heldToGivenTime(dueAt, typed, now) ?? dueAt;
      } else if (his.length === 0) {
        // He gave no time. The model's time stands only if it is the one he is answering
        // ("Shall I set it for 20:00?" "Yes"), the time in the post he forwarded with it ("20:00" on an event), or the task's own time on another day.
        const answering = matchesTime(givenTimes(heard ?? "", now), dueAt) || matchesTime(givenTimes(said, now), dueAt);
        const sameTime = existingDue ? minuteOfDay(new Date(existingDue)) === minuteOfDay(dueAt) : false;
        if (!answering && !sameTime) {
          dayOnly = localDate(dueAt);
          dueAt = undefined;
        }
      }
    }
    if (dueAt && dueAt.getTime() < now.getTime() - 60_000) {
      return { error: `${formatDue(dueAt, now)} has already passed (now is ${formatDue(now, now)}). Ask him which time he means.` };
    }
    if (dueAt) patch.due_at = dueAt.toISOString();
  }
  // "In my free time", "someday": the 🌙 Free Time list, with no date (unless his words also name a day or a time).
  // His own words decide (a time inside a screenshot he sent with it is not his).
  const his = said !== undefined ? ownWords(said) : undefined;
  const freeTime = args.free_time === true || (his !== undefined && args.free_time !== false && isFreeTimeRequest(his) && !dayFromText(his, now) && givenTimes(his, now).length === 0);
  if (freeTime) {
    patch.free_time = true;
    dueAt = undefined;
    delete patch.due_at;
    return { patch, dueAt: undefined, dayOnly: undefined };
  }
  if (args.free_time === false) patch.free_time = false;
  // A day he named without a time: Tony decides or asks, from his routine.
  if (!dueAt && !dayOnly && typeof args.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.day.trim())) {
    dayOnly = args.day.trim();
    const night = said !== undefined ? nightTomorrow(parseLocalDateTime(`${dayOnly}T12:00`)!, said, now) : undefined;
    if (night) dayOnly = localDate(night);
  }
  if (dayOnly && dayOnly < localDate(now)) return { error: `${dayOnly} has already passed. Ask him which day he means.` };
  // A task with no time on its day (Phase J, 23 Nov: "clean your room … I should not be having any timeline"):
  // kept at 20:00 of that day for one quiet check, shown as "anytime", never asked about.
  if (args.anytime === true) {
    const day = dayOnly ?? (dueAt ? localDate(dueAt) : typeof args.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.day.trim()) ? args.day.trim() : startDate(now));
    let at = parseLocalDateTime(`${day}T${String(ANYTIME_HOUR).padStart(2, "0")}:00`)!;
    if (at.getTime() <= now.getTime()) at = toWholeMinute(new Date(now.getTime() + 30 * 60_000));
    patch.anytime = true;
    patch.due_at = at.toISOString();
    // On a day now: no longer "someday".
    patch.free_time = false;
    return { patch, dueAt: at, dayOnly: undefined };
  }
  if (args.anytime === false) patch.anytime = false;
  // A time he gives takes it out of "anytime", and off the 🌙 Free Time list (which holds only what has no date).
  if (dueAt) {
    patch.anytime = false;
    patch.free_time = false;
  }
  return { patch, dueAt, dayOnly };
}

/** "Remind me if I don't check it for N days": a check-in that waits for N untouched days. Returns when it is due. */
async function addCheckIn(taskId: number, args: Args, said: string | undefined, now: Date): Promise<{ days: number; at: string } | undefined> {
  const days = Number(args.nudge_after_days) > 0 ? Math.min(60, Math.round(Number(args.nudge_after_days))) : said ? checkInDays(said) : undefined;
  if (!days) return undefined;
  const db = requireDb();
  await db.from("reminders").update({ state: "cancelled" }).eq("task_id", taskId).eq("kind", "stale").eq("state", "scheduled");
  const at = checkInTime(now, days, await getRoutine());
  const { error } = await db.from("reminders").insert({ task_id: taskId, fire_at: at.toISOString(), kind: "stale", attempt: 0, every_days: days });
  check("check-in", error);
  return { days, at: at.toISOString() };
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
  // Read back: only an attachment that is really there is reported.
  const back = await requireDb().from("media").select("task_id").eq("id", last_shared_media_id).maybeSingle();
  if (Number((back.data as { task_id?: unknown } | null)?.task_id) !== taskId) return "nothing was attached: the photo/file could not be linked to the task";
  return "his photo/file is attached; the reminder will send the original back to him";
}

/**
 * Runs one tool call. Problems come back as { ok: false }, so the model can
 * tell the user. `said` is his message, `heard` what he is answering (Tony's
 * last message, a shared post), `his` his recent messages (what he himself said).
 */
export async function runTool(name: string, args: Args, now = new Date(), said?: string, heard?: string, his?: string): Promise<Result> {
  const db = requireDb();
  switch (name) {
    case "add_task": {
      const fields = await readFields(args, now, { said, heard });
      if ("error" in fields) return fail(fields.error);
      if (!fields.patch.title) return fail("title is required");
      // His Uzbek or Russian words are the title, never a translation of them (23:17: "Zamokli ko'ynak olish").
      // Only words he typed: a forwarded post or a photo's description is not his (21 Nov 18:52: an elevator
      // notice in a forwarded photo, "...пользования лифтом", became the title).
      if (said !== undefined) fields.patch.title = hisTitle(fields.patch.title, ownWords(said));
      // Notes that only repeat the title (his words, once translated by the model) say nothing.
      if (fields.patch.notes && fields.patch.notes.trim().toLowerCase() === fields.patch.title.trim().toLowerCase()) delete fields.patch.notes;
      // A saved link or note gets no date unless his own words gave one: it goes to the inbox.
      if (fields.dueAt && said !== undefined && isLinkTask(fields.patch.title, fields.patch.notes) && !givesTime(ownWords(said))) {
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
      // Its tags: the ones asked for, his own #words, and its series name ("IELTS: …" is #ielts).
      const tags = tagsFor(fields.patch.title, fields.patch.tags ?? [], said !== undefined ? ownWords(said) : "");
      if (tags.length) fields.patch.tags = tags;
      // A habit comes round: daily unless he said otherwise, and on a day, so Tony asks its time if he gave none.
      if (fields.patch.habit === true) {
        fields.patch.repeat_rule ??= "daily";
        if (!fields.dueAt && !fields.dayOnly) fields.dayOnly = localDate(now);
      }
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
      // A time of his own for this kind of task: Tony learns where it belongs.
      if (fields.dueAt && said !== undefined && givenTimes(ownWords(said), now).length > 0) await recordSample(task, fields.dueAt);
      // Its parts, as subtasks (never as a list in the notes).
      const parts = Array.isArray(args.subtasks) ? args.subtasks.map(String).filter((t) => t.trim()) : [];
      if (parts.length) await addSubtasks(task.id, parts);
      const attached = await attachShared(args, task.id);
      const checkIn = await addCheckIn(task.id, args, said, now);
      // What was meant to be written, so it is read back before Tony confirms it.
      return {
        ok: true,
        task_id: task.id,
        task: taskLine(task, await loadProjects(), now),
        wrote: written(fields.patch),
        ...(fields.dayOnly ? { day_only: fields.dayOnly, note: "No time was set: Tony offers one from his routine. Say nothing about a time." } : {}),
        ...(fields.dayOnly && args.pick_time === true ? { tony_picks: true } : {}),
        ...(checkIn ? { check_in: checkIn } : {}),
        ...(attached ? { attached } : {}),
      };
    }

    case "update_task": {
      const task = await loadTask(args.id);
      if (!task) return fail(`no task #${args.id}`);
      // A task he has finished (or dropped) is never reopened, moved or sent to the inbox unless his own words
      // name it (21 Nov 20:25: "Put it inbox" about a NEW task reopened "Posting reel on Instagram", done at 20:15).
      const reopens = args.status !== undefined || args.due_at !== undefined || args.clear_due === true || args.free_time !== undefined;
      if (!OPEN_STATUSES.includes(task.status) && reopens && said !== undefined && !mentions(ownWords(said), task.title)) {
        return fail(`#${task.id} "${task.title}" is already ${task.status}, and his message does not name it: leave it alone. His "it" means something in this message.`);
      }
      // His time holds for the task his words are about ("move IELTS prep to 10:00"), not for another one moved alongside.
      const fields = await readFields(args, now, { said, heard, hold: said !== undefined && mentions(said, task.title) }, task.due_at);
      if ("error" in fields) return fail(fields.error);
      const patch = fields.patch;
      // Notes are added to, never replaced or cleared: nothing he said before is lost.
      if (patch.notes === null) delete patch.notes;
      else if (typeof patch.notes === "string") {
        patch.notes = mergeNotes(task.notes, patch.notes);
        if (patch.notes === (task.notes ?? "").trim()) delete patch.notes;
      }
      const checkInWanted = Number(args.nudge_after_days) > 0 || (said ? checkInDays(said) !== undefined : false);

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
      if (Object.keys(patch).length === 0 && (args.attach_shared === true || fields.dayOnly || checkInWanted)) {
        const attached = args.attach_shared === true ? await attachShared(args, task.id) : undefined;
        const checkIn = await addCheckIn(task.id, args, said, now);
        return {
          ok: true,
          task_id: task.id,
          task: taskLine(task, await loadProjects(), now),
          ...(fields.dayOnly ? { day_only: fields.dayOnly, note: "No time was set: Tony offers one from his routine. Say nothing about a time." } : {}),
          ...(fields.dayOnly && args.pick_time === true ? { tony_picks: true } : {}),
          ...(checkIn ? { check_in: checkIn } : {}),
          ...(attached ? { attached } : {}),
        };
      }
      if (Object.keys(patch).length === 0) return fail("nothing to change");

      const { data, error } = await db.from("tasks").update(patch).eq("id", task.id).select().single();
      check("update_task", error);
      const updated = data as Task;

      if (!OPEN_STATUSES.includes(updated.status) || args.clear_due === true) await settleReminders(task.id);
      else if (fields.dueAt) await scheduleReminder(task.id, fields.dueAt);
      // He moved it to a time of his own: Tony learns where this kind of task belongs.
      if (fields.dueAt && (!task.due_at || minuteOfDay(new Date(task.due_at)) !== minuteOfDay(fields.dueAt))) await recordSample(updated, fields.dueAt);
      const attached = await attachShared(args, task.id);
      const checkIn = OPEN_STATUSES.includes(updated.status) ? await addCheckIn(task.id, args, said, now) : undefined;
      return {
        ok: true,
        task_id: task.id,
        task: taskLine(updated, await loadProjects(), now),
        status: updated.status,
        wrote: written(patch),
        ...(fields.dayOnly ? { day_only: fields.dayOnly } : {}),
        ...(fields.dayOnly && args.pick_time === true ? { tony_picks: true } : {}),
        ...(checkIn ? { check_in: checkIn } : {}),
        ...(attached ? { attached } : {}),
      };
    }

    case "complete_task": {
      const task = await loadTask(args.id);
      if (!task) return fail(`no task #${args.id}`);
      if (task.status === "done") return { ok: true, task_id: task.id, note: "it was already done", task: task.title };
      const { nextLabel } = await finishTask(task, "done", now);
      const habit = isHabit(task) ? await habitFor(task.id, now) : undefined;
      return {
        ok: true,
        task_id: task.id,
        task: task.title,
        ...(nextLabel ? { repeats: `it comes round again ${nextLabel}` } : {}),
        ...(habit ? { streak: streakLine(habit) } : {}),
      };
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
          // After midnight his "tomorrow" is the calendar day that has just begun.
          const anchor =
            day === "today" ? now : day === "tomorrow" ? (isNight(now) ? now : addMinutes(now, 24 * 60)) : parseLocalDateTime(day);
          if (!anchor) return fail(`could not read day "${args.day}"`);
          const bounds = dayBounds(addMinutes(anchor, day.length === 10 ? 12 * 60 : 0));
          query = query.gte("due_at", bounds.start.toISOString()).lt("due_at", bounds.end.toISOString());
        }
      }

      // A tag or "my habits" is filtered here, from a longer list.
      const tag = typeof args.tag === "string" ? normalTag(args.tag) : undefined;
      const narrowed = tag !== undefined || args.habits === true;
      const { data, error } = await query.order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(narrowed ? 300 : 40);
      check("list_tasks", error);
      const wantOverdue = typeof args.day === "string" && args.day.trim().toLowerCase() === "overdue";
      const tasks = (data as Task[])
        .filter((t) => t.kind !== "prayer" && (!wantOverdue || isOverdue(t, now)))
        .filter((t) => (tag === undefined || (t.tags ?? []).includes(tag) || prefixTag(t.title) === tag) && (args.habits !== true || isHabit(t)))
        .slice(0, 40);
      // Each with its notes, parts and attachments, so Tony can say what a task holds.
      const [parts, media] = await Promise.all([subtasksFor(tasks.map((t) => t.id)), attachmentCounts(tasks.map((t) => t.id))]);
      return { ok: true, count: tasks.length, tasks: tasks.map((t) => taskLine(t, projects, now, undefined, parts.get(t.id), media.get(t.id), tasks.length <= 12 ? 700 : 160)) };
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
      // Moving the task needs a time from him; with only a day, Tony decides or asks from his routine.
      if (decision === "move" && said !== undefined && givenTimes(said, now).length === 0 && !matchesTime(givenTimes(heard ?? "", now), at) && !(task.due_at && minuteOfDay(new Date(task.due_at)) === minuteOfDay(at))) {
        return { ok: true, task_id: task.id, task: task.title, day_only: localDate(at), note: "No time was set: Tony offers one from his routine. Say nothing about a time." };
      }
      if (decision === "move") {
        // A reminder after the task's time (or for an undated task) is a reschedule: the task itself moves.
        const moved = await db.from("tasks").update({ due_at: at.toISOString(), status: task.status === "inbox" ? "todo" : task.status }).eq("id", task.id);
        check("set_reminder", moved.error);
        await scheduleReminder(task.id, at);
        if (!task.due_at || minuteOfDay(new Date(task.due_at)) !== minuteOfDay(at)) await recordSample(task, at);
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
      // No layer named: a new note is kept for good, a known one stays where it is (never moved up by default).
      const given = args.layer === undefined || args.layer === null || args.layer === "" ? undefined : readLayer(args.layer);
      const layer = given ?? "always";
      const goal = args.goal === true;
      // Only what he said himself: never Tony's own replies, never a guess ("Khiva area" for Khanqa).
      if (fact && his !== undefined && !statedByHim(fact, his)) {
        return fail("Only remember what he said himself, in his own words: most of this fact is not in his messages. Leave it out, or use his words.");
      }
      type Kept = { id: number; fact: string; layer: MemoryLayer; mentions: number; goal: boolean };
      // Said again: the note is confirmed, counts one more mention, and may move up a layer (never down).
      const confirm = async (note: Kept) => {
        const patch: Record<string, unknown> = { mentions: note.mentions + 1, confirmed_at: now.toISOString(), layer: given ? higherLayer(note.layer, given) : note.layer };
        if (goal && !note.goal) patch.goal = true;
        if (fact && fact.toLowerCase() !== note.fact.toLowerCase()) patch.fact = fact;
        const { error } = await db.from("memory").update(patch).eq("id", note.id);
        check("remember", error);
        // Nothing new (same words, same layer, same goal): confirmed quietly, no receipt.
        const changed = patch.fact !== undefined || patch.layer !== note.layer || patch.goal === true;
        return { ok: true as const, id: note.id, fact: String(patch.fact ?? note.fact), layer: patch.layer, confirmed: true, changed };
      };
      const sameAs = Number(args.same_as);
      if (Number.isSafeInteger(sameAs) && sameAs > 0) {
        const note = (await db.from("memory").select("id, fact, layer, mentions, goal").eq("id", sameAs).maybeSingle()).data as Kept | null;
        if (note) return confirm(note);
      }
      if (!fact) return fail("fact is required");
      // Already known (same words, any case): confirmed, not duplicated.
      const known = await db.from("memory").select("id, fact, layer, mentions, goal").ilike("fact", fact.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1);
      if (!known.error && (known.data ?? []).length > 0) return confirm((known.data as Kept[])[0]);
      const { data, error } = await db.from("memory").insert({ fact, source: "user", layer, goal, confirmed_at: now.toISOString() }).select("id").single();
      check("remember", error);
      return { ok: true, id: (data as { id: number }).id, fact, layer };
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
      // Kept in his library (phase b), never in memory: memory is for facts about him.
      const id = await saveToLibrary({ kind: "link", url, title, source: "saved" });
      if (id === undefined) return fail("the link could not be saved");
      return { ok: true, saved: title, url, item: `library:${id}` };
    }

    case "library": {
      const action = String(args.action ?? "");
      const item = typeof args.item === "string" && args.item.trim() ? await loadItem(args.item.trim()) : undefined;
      if (action === "find") {
        const query = typeof args.text === "string" ? args.text : "";
        const found = item ? { found: item } : await findInLibrary(query, now);
        const list = found.found ? [found.found] : (found.choices ?? []);
        if (list.length === 0) return { ok: true, items: [], note: "nothing in his library fits; say so" };
        return { ok: true, items: list.map((entry) => `${itemRef(entry)} ${itemLabel(entry, now)}${entry.url ? ` ${entry.url}` : ""}`), ...(found.choices ? { note: "several fit equally: ask him which, with their titles" } : {}) };
      }
      if (action === "send") {
        const refs = [...(Array.isArray(args.items) ? args.items.map(String) : []), ...(typeof args.item === "string" ? [args.item] : [])].map((ref) => ref.trim()).filter(Boolean).slice(0, 3);
        const found: LibraryItem[] = [];
        const wholeTasks: { ref: string; label: string }[] = [];
        for (const ref of refs) {
          // "task:12": everything kept with that task, sent together.
          const taskRef = /^task:#?(\d+)$/.exec(ref);
          if (taskRef) {
            const task = await loadTask(Number(taskRef[1]));
            const files = task ? await attachmentCounts([task.id]) : undefined;
            const counts = files?.get(task!.id);
            if (task && counts && (counts.photo || counts.video || counts.file)) wholeTasks.push({ ref: `task:${task.id}`, label: `${task.title}: ${[counts.photo ? `${counts.photo} photo${counts.photo > 1 ? "s" : ""}` : "", counts.video ? `${counts.video} video${counts.video > 1 ? "s" : ""}` : "", counts.file ? `${counts.file} file${counts.file > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")}` });
            continue;
          }
          const entry = await loadItem(ref);
          if (entry) found.push(entry);
        }
        if (found.length === 0 && wholeTasks.length === 0) return fail("no such item: use a reference from the Library list (\"library:3\", \"media:7\", \"task:12\" for a task's files) or find it first");
        // Tony sends them after the reply; the reply only says a word around them.
        return { ok: true, send_items: [...wholeTasks.map((task) => task.ref), ...found.map(itemRef)], sending: [...wholeTasks.map((task) => task.label), ...found.map((entry) => itemLabel(entry, now))] };
      }
      if (action === "read") {
        if (!item) return fail("read needs an item from the Library list, e.g. \"media:7\"");
        // A PDF or text file kept before Tony could read it whole (the IELTS plan, 22 Nov): read again, from its stored copy.
        if (item.source === "media" && item.kind === "document" && needsReading(item.description)) {
          const description = await rereadDocument(item.id);
          if (description) item.description = description;
        }
        const text = item.description?.trim();
        if (!text) return { ok: true, item: itemLabel(item, now), text: "", note: "Tony could not read anything in it" };
        // Long ones in pages of 12,000 characters: "from" is where the next page starts.
        const from = Math.max(0, Math.floor(Number(args.from) || 0));
        const page = text.slice(from, from + 12_000);
        const next = from + 12_000 < text.length ? from + 12_000 : undefined;
        return { ok: true, item: itemLabel(item, now), text: page, ...(next !== undefined ? { next_from: next, note: `the document goes on: library read with from ${next} for the next part` } : {}) };
      }
      if (action === "attach") {
        const task = await loadTask(args.task_id);
        if (!task) return fail(`no task #${args.task_id}`);
        const target = item ?? (typeof args.text === "string" ? (await findInLibrary(args.text, now)).found : undefined);
        if (!target) return fail("no single item fits: find it first, or ask him which");
        if (!(await attachItem(target, task.id))) return fail("it could not be attached");
        return { ok: true, task_id: task.id, task: taskLine(task, await loadProjects(), now), attached: itemLabel(target, now), wrote: {} };
      }
      if (action === "forget") {
        // "Forget this pdf file" (23 Nov 04:17, answered "I can't delete the PDF"): gone from his library for good.
        if (!item) return fail("forget needs an item from the Library list, e.g. \"media:7\"");
        if (!(await forgetItem(item))) return fail("it could not be removed");
        return { ok: true, forgotten_item: itemLabel(item, now) };
      }
      return fail("library action must be send, find, read, attach or forget");
    }

    case "rule": {
      const action = String(args.action ?? "");
      if (action === "add") {
        const result = await addRule({ situation: String(args.situation ?? ""), action: String(args.do ?? ""), item: typeof args.attach === "string" && args.attach.trim() ? args.attach.trim() : undefined }, now);
        if (!result.ok) return fail(result.error);
        const without = result.rule.skip_kind === "workout" ? "a workout" : result.rule.skip_kind;
        return { ok: true, rule: { id: result.rule.id, situation: result.rule.situation, action: result.rule.action, item: result.item ? itemLabel(result.item, now) : undefined, skip: result.rule.skip_days ? `${result.rule.skip_days} days without ${without}` : undefined } };
      }
      if (action === "delete") {
        const id = Number(args.id);
        if (!Number.isSafeInteger(id)) return fail("which rule? give its id");
        return (await deleteRule(id)) ? { ok: true, rule_deleted: id } : fail("that rule could not be removed");
      }
      if (action === "list") return { ok: true, show_rules: true };
      return fail("rule action must be add, delete or list");
    }

    case "main_priority": {
      const ids = Array.isArray(args.task_ids) ? args.task_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [];
      if (args.action === "clear") {
        let query = db.from("tasks").update({ main_priority: false }).eq("main_priority", true);
        if (ids.length) query = query.in("id", ids);
        const { data, error } = await query.select("title");
        check("main_priority", error);
        return { ok: true, main_cleared: ((data ?? []) as { title: string }[]).map((row) => row.title) };
      }
      if (args.action !== "set") return fail("action must be set or clear");
      if (ids.length === 0) return fail("task_ids: the task he named (or the sessions of one plan) to make his main priority");
      const found = await db.from("tasks").select("id, title, status, due_at").in("id", ids);
      check("main_priority", found.error);
      const open = ((found.data ?? []) as { id: number; title: string; status: string; due_at: string | null }[]).filter((row) => OPEN_STATUSES.includes(row.status as Task["status"]));
      if (open.length === 0) return fail("none of those tasks is open");
      // One main priority, the last one cleared, unless he wants this one as well ("it is also the main task",
      // "both of them main", 23 Nov 05:47): then they are chased one after the other, earliest first.
      const keep = open.map((row) => row.id);
      const also = args.add === true || /\b(also|too|both|as well|another|second)\b/i.test(said ?? "");
      const cleared = also ? { data: [], error: null } : await db.from("tasks").update({ main_priority: false }).eq("main_priority", true).not("id", "in", `(${keep.join(",")})`).select("title");
      check("main_priority", cleared.error);
      const set = await db.from("tasks").update({ main_priority: true }).in("id", keep).select("id, title, due_at");
      check("main_priority", set.error);
      // A main priority with no day is today's (23 Nov 05:52: two main tasks sat in the inbox and were missing
      // from "today's tasks"): on today's list with no time; the chase itself starts at 10:00.
      const { placeAnytime } = await import("../slots");
      for (const row of (set.data ?? []) as { id: number; due_at: string | null }[]) if (!row.due_at) await placeAnytime(row.id, startDate(now), now);
      const rows = ((set.data ?? []) as { id: number; title: string; due_at: string | null }[]).sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"));
      return { ok: true, main: rows.map((row) => row.title), replaced: ((cleared.data ?? []) as { title: string }[]).map((row) => row.title), note: "Tony chases it in code; say nothing about how it works" };
    }

    case "rule_fire": {
      const fired = await fireRule(Number(args.id), now);
      if (!fired) return fail("no such rule");
      return { ok: true, send_item: fired.item ? itemRef(fired.item) : undefined, item: fired.item ? itemLabel(fired.item, now) : undefined, url: fired.item?.url ?? undefined };
    }

    case "routine": {
      if (args.field === "decide") {
        const result = await setAutoKinds(String(args.value ?? ""), args.on !== false);
        return result.ok ? { ok: true, routine: { field: "decide", value: result.label, on: result.on } } : fail(result.error);
      }
      const result = await setRoutineField(String(args.field ?? ""), String(args.value ?? ""));
      return result.ok ? { ok: true, routine: { field: result.field, value: result.value } } : fail(result.error);
    }

    case "propose": {
      const say = typeof args.say === "string" ? args.say.trim().slice(0, 300) : "";
      const toolName = String(args.tool ?? "");
      const toolArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Args) : undefined;
      if (!say || !toolArgs || !PROPOSABLE.has(toolName)) return fail("propose needs say, a tool (add_task, update_task, complete_task, set_reminder, subtask, remember, forget, rule) and its args");
      // He has already said yes to Tony's question ("Remove all 13 sessions…?" "Yes, remove them all", 23 Nov
      // 04:18: thirteen proposals were made and one ran): it is done now, not asked again.
      if (answersYes(said ?? "", heard ?? "")) {
        return runTool(toolName, toolArgs, now, said, heard, his);
      }
      const { data, error } = await db.from("offers").insert({ kind: "action", payload: { say, tool: toolName, args: toolArgs, said: said ?? null, heard: heard ?? null } }).select("id").single();
      check("propose", error);
      return { ok: true, proposal_id: (data as { id: number }).id, say };
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
      // The day he named is the day planned, never swapped for tomorrow (22 Nov 16:15-16:17: "for today",
      // "Today isn't over", "i asked for today", "i meant 22 november", and four plans for tomorrow).
      const exactDay = (dayText !== "today" && dayText !== "") || namesDay(said !== undefined ? ownWords(said) : "", localDate(now));
      const result = await buildPlan({ scope, day, now, exactDay, all: args.all === true, instructions: typeof args.instructions === "string" ? args.instructions.slice(0, 300) : undefined });
      if ("nothing" in result) return fail(result.nothing);
      const planned = String(result.plan.day).slice(0, 10);
      return {
        ok: true,
        plan_id: result.plan.id,
        day: planned,
        ...(planned !== localDate(now) && localDate(day) === localDate(now) ? { note: "Today was nearly over, so this plan is for tomorrow: say so, in a few words." } : {}),
        placed: result.plan.items.length,
        left_out: result.plan.left_out.length,
      };
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
      // A list to choose from, never sent as it is: send the one he means with library send.
      return { ok: true, items: found.map((item) => `media:${item.id} ${mediaLabel(item)}`), note: "send the one he asked for with library send (usually one)" };
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

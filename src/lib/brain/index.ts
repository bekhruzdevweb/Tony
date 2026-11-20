import "server-only";
import { buildPlan } from "../planner";
import { dayFromText } from "../schedule";
import { progress, subtasksFor } from "../subtasks";
import { clashSentence, clashesWith, confirmationFor, freeOptions, isLinkTask, latestMessage, needsDeepModel, nextFreeSlot, recentReminderNote, type DoneAction } from "./checks";
import { env } from "../env";
import { formatTime, localDate, parseLocalDateTime } from "../time";
import { habitsForPrompt } from "../coach";
import { requireDb } from "../db";
import { logMessage, recentMessages, type Channel } from "../messages";
import { OPEN_STATUSES, type Task } from "../tasks";
import { chat, type ChatMessage } from "./model";
import { buildSystemPrompt, type MemoryFact, type ProjectRef, type ReminderFact } from "./prompt";
import { tidyReply } from "./tidy";
import { runTool, TOOLS } from "./tools";

/** Recent turns sent for context. Each is clipped; old chatter is not worth its tokens. */
const HISTORY = 6;
const HISTORY_CHARS = 280;
const clip = (text: string) => (text.length > HISTORY_CHARS ? `${text.slice(0, HISTORY_CHARS)}…` : text);
const MAX_ROUNDS = 5;

/** How long "this" keeps meaning the last forwarded post or photo. */
const SHARED_HOURS = 12;
/** Enough of a post to find its date and subject, without spending the minute's token allowance on it. */
const SHARED_CHARS = 700;

function recentShare(row: { last_shared_text: string | null; last_shared_at: string | null } | null) {
  if (!row?.last_shared_text || !row.last_shared_at) return undefined;
  const at = new Date(row.last_shared_at);
  if (Date.now() - at.getTime() > SHARED_HOURS * 60 * 60_000) return undefined;
  const text = row.last_shared_text;
  return { at, text: text.length > SHARED_CHARS ? `${text.slice(0, SHARED_CHARS)}…` : text };
}

/** A question Tony put to him stays "open" this long. */
const NOTE_MINUTES = 30;

function recentNote(row: { pending_note: string | null; pending_note_at: string | null } | null) {
  if (!row?.pending_note || !row.pending_note_at) return undefined;
  return Date.now() - new Date(row.pending_note_at).getTime() > NOTE_MINUTES * 60_000 ? undefined : row.pending_note;
}

async function loadContext() {
  const db = requireDb();
  const [memory, tasks, projects, settings, habits] = await Promise.all([
    db.from("memory").select("id, fact").order("id"),
    db.from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(60),
    db.from("projects").select("id, name").order("sort_order"),
    db.from("settings").select("last_shared_text, last_shared_at, pending_note, pending_note_at").limit(1).maybeSingle(),
    habitsForPrompt(),
  ]);
  for (const result of [memory, tasks, projects]) {
    if (result.error) throw new Error(`loadContext: ${result.error.message}`);
  }
  const everything = tasks.data as Task[];
  // Prayers are not tasks to manage; the model gets today's times as one line instead.
  const openTasks = everything.filter((task) => task.kind !== "prayer");
  const prayers = everything
    .filter((task) => task.kind === "prayer" && task.due_at && localDate(new Date(task.due_at)) === localDate(new Date()))
    .sort((a, b) => a.due_at!.localeCompare(b.due_at!))
    .map((task) => `${task.title} ${formatTime(new Date(task.due_at!))}`)
    .join(", ");
  // What actually happened with each task's reminders, so Tony can answer
  // "you didn't remind me" from the record instead of guessing.
  const reminders = openTasks.length
    ? await db
        .from("reminders")
        .select("task_id, state, fire_at, sent_at")
        .in("task_id", openTasks.map((t) => t.id))
        .in("state", ["scheduled", "sent", "acknowledged"])
        .order("id", { ascending: false })
        .limit(200)
    : { data: [], error: null };
  if (reminders.error) throw new Error(`loadContext: ${reminders.error.message}`);
  return {
    memory: memory.data as MemoryFact[],
    tasks: openTasks,
    projects: projects.data as ProjectRef[],
    reminders: (reminders.data ?? []) as ReminderFact[],
    shared: recentShare(settings.data as { last_shared_text: string | null; last_shared_at: string | null } | null),
    waiting: recentNote(settings.data as { pending_note: string | null; pending_note_at: string | null } | null),
    habits,
    prayers: prayers || undefined,
    subtasks: await subtasksFor(openTasks.map((task) => task.id)),
  };
}

/**
 * Tony's brain: one user message in, one short reply out. The same function
 * serves Telegram and the app, so both share one conversation.
 * Throws if the model cannot be reached; the caller decides the fallback.
 */
export async function respond(text: string, channel: Channel = "telegram", now = new Date()): Promise<string> {
  return (await think(text, { channel, now })).reply;
}

/**
 * As respond, and also reports which tools succeeded. `context` is a note
 * for the model only (for example, which reminder he is replying to); it is
 * not stored in the conversation.
 */
export async function think(
  text: string,
  options: { channel?: Channel; now?: Date; context?: string } = {},
): Promise<{
  reply: string;
  tools: string[];
  titles: string[];
  planId?: number;
  choices?: { question: string; options: string[] };
  mediaIds?: number[];
  /** Tasks offered in conversation, each shown with a [➕ Make this a task] button. */
  offerIds?: number[];
  /** Pages Tony read with web_fetch (a link he sent). */
  fetched?: { url: string; title: string }[];
  /** A clash the changes created, for [Move …] [Keep both] buttons. */
  clash?: Clash;
  /** Every part of this task was just ticked: ask before completing it. */
  askComplete?: { taskId: number; title: string };
}> {
  const { channel = "telegram", now = new Date(), context: note } = options;
  const tools: string[] = [];
  // Titles of the tasks the tools touched, so the reply can show them in bold.
  const titles: string[] = [];
  // A plan to show with Apply/Adjust, or a question to show with buttons.
  let planId: number | undefined;
  let choices: { question: string; options: string[] } | undefined;
  // Saved photos or files he asked to see again.
  let mediaIds: number[] | undefined;
  const offerIds: number[] = [];
  // Web pages behind the answer, listed under it as links.
  const sources = new Map<string, string>();
  const fetched: { url: string; title: string }[] = [];
  const [context, history] = await Promise.all([loadContext(), recentMessages(HISTORY)]);
  await logMessage("user", text, channel);

  const system = buildSystemPrompt({ now, ...context, message: text });
  // "This one" with nothing replied to: the reminder sent in the last 15 minutes.
  const recent = await recentReminders(now);
  const notes = [note, note?.includes("replying to your reminder") ? undefined : recentReminderNote(recent, now)].filter(Boolean).join(" ");
  const messages: ChatMessage[] = [
    ...history.map(
      (m): ChatMessage => (m.role === "user" ? { role: "user", content: clip(m.text) } : { role: "assistant", content: clip(m.text) }),
    ),
    // The newest message is marked, so an earlier one is never answered in its place.
    { role: "user", content: latestMessage(text, notes || undefined) },
  ];
  // Several requests, or moving and planning things: the larger model.
  const model = needsDeepModel(text) ? env.anthropicDeepModel : undefined;

  // Every task number the model has seen, so none of them can leak into a reply.
  const taskIds = new Set(context.tasks.map((task) => task.id));
  // What really changed, by task, in order: the reply is built from these, read back from the database.
  const changes = new Map<number, { tool: DoneAction["tool"]; reminder_at?: string }>();
  const saved: string[] = [];
  let failed = false;
  let askComplete: { taskId: number; title: string } | undefined;
  let reply: string | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await chat({ system, messages, tools: TOOLS, web: true, model });
    for (const source of answer.sources ?? []) if (!sources.has(source.url)) sources.set(source.url, source.title);
    for (const page of answer.fetched ?? []) if (!fetched.some((known) => known.url === page.url)) fetched.push(page);
    if (!answer.tool_calls) {
      reply = tidyReply(answer.content ?? "", [...taskIds]);
      break;
    }
    // Anything the model says while calling a tool is dropped: it has not seen
    // the result yet, and keeping it made the final reply repeat itself
    // ("Remembered, sir.Your preference is noted, sir.").
    messages.push({ role: "assistant", content: null, tool_calls: answer.tool_calls, raw: answer.raw });
    // The model's own confirmation is used only where no task changed (a memory note, say):
    // a task change is confirmed from what is stored, never from what the model predicted.
    let prepared: string | undefined;
    let allSucceeded = true;
    for (const call of answer.tool_calls) {
      let result: unknown;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        const outcome = await runTool(call.function.name, args, now, text);
        for (const match of JSON.stringify(outcome).matchAll(/#(\d+)/g)) taskIds.add(Number(match[1]));
        if (outcome.ok) {
          tools.push(call.function.name);
          if (call.function.name === "plan") planId = Number((outcome as { plan_id?: unknown }).plan_id);
          if (call.function.name === "media" && Array.isArray((outcome as { media_ids?: unknown }).media_ids)) mediaIds = (outcome as unknown as { media_ids: number[] }).media_ids;
          if (call.function.name === "ask") {
            // Only times that are actually free are offered as buttons.
            const asked = outcome as unknown as { question: string; options: string[] };
            const open = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).not("due_at", "is", null);
            const options = freeOptions(asked.options, (open.data ?? []) as Task[], now);
            choices = options.length >= 2 ? { question: asked.question, options } : undefined;
            if (!choices) prepared = asked.question;
          }
          if (call.function.name === "offer_task") offerIds.push(Number((outcome as { offer_id?: unknown }).offer_id));
          if (call.function.name === "save_link") saved.push(String((outcome as { saved?: unknown }).saved ?? "the link"));
          const touchedId = Number((outcome as { task_id?: unknown }).task_id);
          if (TASK_TOOLS.has(call.function.name) && Number.isFinite(touchedId)) {
            const reminderAt = (outcome as { reminder_at?: unknown }).reminder_at;
            const tool = call.function.name as DoneAction["tool"];
            // A task added with its parts in the same turn stays an "add".
            if (!(tool === "subtask" && changes.has(touchedId))) changes.set(touchedId, { tool, ...(typeof reminderAt === "string" ? { reminder_at: reminderAt } : {}) });
            // Every part ticked: ask before marking the task itself done.
            if (call.function.name === "subtask" && (outcome as { all_done?: unknown }).all_done === true) askComplete = { taskId: touchedId, title: String((outcome as { task?: unknown }).task ?? "") };
          }
          const touched = (outcome as { task?: unknown }).task;
          if (typeof touched === "string") titles.push(touched.replace(/^#\d+\s+/, "").split(" | ")[0]);
          if (typeof args.reply === "string" && args.reply.trim()) prepared = args.reply;
          else if (!TASK_TOOLS.has(call.function.name) && call.function.name !== "save_link") allSucceeded = false; // a lookup: the model must speak next
        } else {
          allSucceeded = false;
          failed = true;
        }
        result = outcome;
      } catch (error) {
        console.error(`Tool ${call.function.name} failed:`, error);
        allSucceeded = false;
        failed = true;
        result = { ok: false, error: "the tool failed; nothing was changed" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    // A plan or a question is shown by the app or bot itself; nothing more for the model to say.
    if (planId !== undefined) {
      reply = "Here is what I propose, sir.";
      break;
    }
    if (choices) {
      reply = tidyReply(choices.question, [...taskIds]) || choices.question;
      break;
    }
    // Done in one model call: the confirmation is built below from the database.
    if (allSucceeded && (changes.size > 0 || saved.length > 0 || prepared)) {
      if (changes.size === 0 && saved.length === 0) reply = tidyReply(prepared!, [...taskIds]);
      break;
    }
  }

  // The confirmation: what is really stored now, one line per change.
  let clash: Clash | undefined;
  if (changes.size > 0) {
    const { data } = await requireDb().from("tasks").select().in("id", [...changes.keys()]);
    const stored = new Map(((data ?? []) as Task[]).map((task) => [task.id, task]));
    // Several new tasks without times: a free slot proposed for each, on one line, with Looks good / Change.
    const undated = [...changes]
      .filter(([id, change]) => change.tool === "add_task" && stored.get(id) && !stored.get(id)!.due_at && !isLinkTask(stored.get(id)!.title, stored.get(id)!.notes))
      .map(([id]) => id);
    // He named a day: the tasks are drafts until he confirms the proposed times ("nothing is saved").
    // He named none: they stay in the inbox, quietly. No suggested time unless he asks for one.
    const day = undated.length >= 1 && planId === undefined ? dayFromText(text, now) : undefined;
    if (day) {
      if (day) await requireDb().from("tasks").update({ status: "draft" }).in("id", undated);
      const proposal = await buildPlan({ scope: "day", now, taskIds: undated, day }).catch(
        (error) => (console.error("Slot proposal failed:", error), undefined),
      );
      if (!proposal || !("plan" in proposal)) {
        // No room anywhere: the tasks are kept in the inbox rather than lost.
        if (day) await requireDb().from("tasks").update({ status: "inbox" }).in("id", undated).eq("status", "draft");
      }
      if (proposal && "plan" in proposal) {
        planId = proposal.plan.id;
        reply = "Here is what I propose, sir.";
        await logMessage("tony", reply, channel);
        return { reply, tools, titles, planId, choices, mediaIds, offerIds: offerIds.filter(Number.isFinite), fetched };
      }
    }
    const parts = await subtasksFor([...changes.keys()]);
    const done: DoneAction[] = [...changes].flatMap(([id, change]) => {
      const task = stored.get(id);
      const list = parts.get(id);
      return task ? [{ tool: change.tool, title: task.title, status: task.status, due_at: task.due_at, ...(change.reminder_at ? { reminder_at: change.reminder_at } : {}), ...(list?.length ? { parts: progress(list) } : {}) }] : [];
    });
    const confirmation = done.length ? confirmationFor(done, now) : "";
    // If something failed, the model's own words explain it; the confirmation shows what did happen.
    reply = [failed && reply ? reply : undefined, confirmation].filter(Boolean).join("\n\n");
    clash = await findClash([...stored.values()], now);
    if (askComplete && stored.get(askComplete.taskId)?.status === "done") askComplete = undefined;
    if (askComplete) reply = `${reply}\n\nEvery part of **${askComplete.title}** is done, sir. Mark the task itself done?`;
    if (clash) reply = `${reply}\n\n⚠️ Sir, ${clash.sentence}${clash.suggestAt ? ": move one?" : "."}`;
  }
  if (saved.length > 0) {
    const lines = saved.map((title) => `💾 Saved: **${title}**`).join("\n");
    reply = reply ? `${reply}\n${lines}` : `${lines}. Ask me for it any time, sir.`;
  }

  reply ||= "My apologies, sir. I lost my thread there; could you say that once more?";
  // Cited web pages, as links under the answer (a page he sent himself is not listed back to him).
  const listed = [...sources].filter(([url]) => !fetched.some((page) => page.url === url) && !reply!.includes(url)).slice(0, 4);
  if (listed.length > 0) reply = `${reply}\n\n**Sources**\n${listed.map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`).join("\n")}`;
  await logMessage("tony", reply, channel);
  return { reply, tools, titles, planId, choices, mediaIds, offerIds: offerIds.filter(Number.isFinite), fetched, clash, askComplete };
}

const TASK_TOOLS = new Set(["add_task", "update_task", "complete_task", "set_reminder", "subtask"]);

/** A clash a change created, and where the changed task could go instead. */
export type Clash = { taskId: number; title: string; sentence: string; suggestAt?: Date };

/** Checks each changed, open, timed task against the rest of the list (±30 min, or by duration). */
async function findClash(changed: Task[], now: Date): Promise<Clash | undefined> {
  const timed = changed.filter((task) => task.due_at && OPEN_STATUSES.includes(task.status) && task.kind !== "prayer");
  if (timed.length === 0) return undefined;
  const { data, error } = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).not("due_at", "is", null).gte("due_at", now.toISOString());
  if (error) return undefined;
  const others = (data ?? []) as Task[];
  for (const task of timed) {
    const clashing = clashesWith(task, others);
    if (clashing.length === 0) continue;
    const latest = parseLocalDateTime(`${localDate(new Date(task.due_at!))}T23:00`)!;
    return { taskId: task.id, title: task.title, sentence: clashSentence(clashing[0], task), suggestAt: nextFreeSlot(task, others, latest) };
  }
  return undefined;
}

/** Reminders sent in the last 15 minutes, with their tasks' titles. */
async function recentReminders(now: Date): Promise<{ task_id: number | null; title: string; sent_at: string }[]> {
  const db = requireDb();
  const { data } = await db.from("reminders").select("task_id, sent_at").in("state", ["sent", "acknowledged"]).gte("sent_at", new Date(now.getTime() - 15 * 60_000).toISOString());
  const rows = ((data ?? []) as { task_id: number | null; sent_at: string }[]).filter((row) => row.task_id !== null);
  if (rows.length === 0) return [];
  const tasks = await db.from("tasks").select("id, title, kind").in("id", rows.map((row) => row.task_id!));
  const byId = new Map(((tasks.data ?? []) as { id: number; title: string; kind: string | null }[]).filter((task) => task.kind !== "prayer").map((task) => [task.id, task.title]));
  return rows.filter((row) => byId.has(row.task_id!)).map((row) => ({ ...row, title: byId.get(row.task_id!)! }));
}

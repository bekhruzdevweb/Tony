import "server-only";
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
  const [memory, tasks, projects, settings] = await Promise.all([
    db.from("memory").select("id, fact").order("id"),
    db.from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(60),
    db.from("projects").select("id, name").order("sort_order"),
    db.from("settings").select("last_shared_text, last_shared_at, pending_note, pending_note_at").limit(1).maybeSingle(),
  ]);
  for (const result of [memory, tasks, projects]) {
    if (result.error) throw new Error(`loadContext: ${result.error.message}`);
  }
  const openTasks = tasks.data as Task[];
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
): Promise<{ reply: string; tools: string[]; titles: string[]; planId?: number; choices?: { question: string; options: string[] }; mediaIds?: number[] }> {
  const { channel = "telegram", now = new Date(), context: note } = options;
  const tools: string[] = [];
  // Titles of the tasks the tools touched, so the reply can show them in bold.
  const titles: string[] = [];
  // A plan to show with Apply/Adjust, or a question to show with buttons.
  let planId: number | undefined;
  let choices: { question: string; options: string[] } | undefined;
  // Saved photos or files he asked to see again.
  let mediaIds: number[] | undefined;
  const [context, history] = await Promise.all([loadContext(), recentMessages(HISTORY)]);
  await logMessage("user", text, channel);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ now, ...context, message: text }) },
    ...history.map(
      (m): ChatMessage => (m.role === "user" ? { role: "user", content: clip(m.text) } : { role: "assistant", content: clip(m.text) }),
    ),
    { role: "user", content: note ? `${text}\n\n[${note}]` : text },
  ];

  // Every task number the model has seen, so none of them can leak into a reply.
  const taskIds = new Set(context.tasks.map((task) => task.id));
  let reply: string | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await chat(messages, TOOLS);
    if (!answer.tool_calls) {
      reply = tidyReply(answer.content ?? "", [...taskIds]);
      break;
    }
    // Anything the model says while calling a tool is dropped: it has not seen
    // the result yet, and keeping it made the final reply repeat itself
    // ("Remembered, sir.Your preference is noted, sir.").
    messages.push({ role: "assistant", content: null, tool_calls: answer.tool_calls });
    // The confirmation the model wrote alongside its tool call, usable only if every call succeeds.
    let prepared: string | undefined;
    let allSucceeded = true;
    for (const call of answer.tool_calls) {
      let result: unknown;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        const outcome = await runTool(call.function.name, args, now);
        for (const match of JSON.stringify(outcome).matchAll(/#(\d+)/g)) taskIds.add(Number(match[1]));
        if (outcome.ok) {
          tools.push(call.function.name);
          if (call.function.name === "plan") planId = Number((outcome as { plan_id?: unknown }).plan_id);
          if (call.function.name === "media" && Array.isArray((outcome as { media_ids?: unknown }).media_ids)) mediaIds = (outcome as unknown as { media_ids: number[] }).media_ids;
          if (call.function.name === "ask") choices = outcome as unknown as { question: string; options: string[] };
          const touched = (outcome as { task?: unknown }).task;
          if (typeof touched === "string") titles.push(touched.replace(/^#\d+\s+/, "").split(" | ")[0]);
          if (typeof args.reply === "string" && args.reply.trim()) prepared = args.reply;
          else allSucceeded = false; // nothing prepared (a lookup, say): the model must speak next
        } else {
          allSucceeded = false;
        }
        result = outcome;
      } catch (error) {
        console.error(`Tool ${call.function.name} failed:`, error);
        allSucceeded = false;
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
    // Done in one model call: no second round just to say "Noted, sir".
    if (allSucceeded && prepared) {
      reply = tidyReply(prepared, [...taskIds]);
      if (reply) break;
    }
  }

  reply ||= "My apologies, sir. I lost my thread there; could you say that once more?";
  await logMessage("tony", reply, channel);
  return { reply, tools, titles, planId, choices, mediaIds };
}

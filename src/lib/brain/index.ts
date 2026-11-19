import "server-only";
import { requireDb } from "../db";
import { logMessage, recentMessages, type Channel } from "../messages";
import { OPEN_STATUSES, type Task } from "../tasks";
import { chat, type ChatMessage } from "./model";
import { buildSystemPrompt, type MemoryFact, type ProjectRef, type ReminderFact } from "./prompt";
import { tidyReply } from "./tidy";
import { runTool, TOOLS } from "./tools";

const HISTORY = 12;
const MAX_ROUNDS = 5;

async function loadContext() {
  const db = requireDb();
  const [memory, tasks, projects] = await Promise.all([
    db.from("memory").select("id, fact").order("id"),
    db.from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(60),
    db.from("projects").select("id, name").order("sort_order"),
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
): Promise<{ reply: string; tools: string[] }> {
  const { channel = "telegram", now = new Date(), context: note } = options;
  const tools: string[] = [];
  const [context, history] = await Promise.all([loadContext(), recentMessages(HISTORY)]);
  await logMessage("user", text, channel);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ now, ...context }) },
    ...history.map(
      (m): ChatMessage => (m.role === "user" ? { role: "user", content: m.text } : { role: "assistant", content: m.text }),
    ),
    { role: "user", content: note ? `${text}\n\n[${note}]` : text },
  ];

  let reply: string | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await chat(messages, TOOLS);
    if (!answer.tool_calls) {
      reply = tidyReply(answer.content ?? "");
      break;
    }
    // Anything the model says while calling a tool is dropped: it has not seen
    // the result yet, and keeping it made the final reply repeat itself
    // ("Remembered, sir.Your preference is noted, sir.").
    messages.push({ role: "assistant", content: null, tool_calls: answer.tool_calls });
    for (const call of answer.tool_calls) {
      let result: unknown;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        const outcome = await runTool(call.function.name, args, now);
        if (outcome.ok) tools.push(call.function.name);
        result = outcome;
      } catch (error) {
        console.error(`Tool ${call.function.name} failed:`, error);
        result = { ok: false, error: "the tool failed; nothing was changed" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  reply ||= "My apologies, sir. I lost my thread there; could you say that once more?";
  await logMessage("tony", reply, channel);
  return { reply, tools };
}

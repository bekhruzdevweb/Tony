import "server-only";
import { dayFromText } from "../schedule";
import { progress, subtasksFor } from "../subtasks";
import { clashSentence, clashesWith, confirmationFor, freeOptions, latestMessage, needsDeepModel, recentReminderNote, savedMarks, type DoneAction, type Touch } from "./checks";
import { env } from "../env";
import { formatTime, formatWhen, localDate, parseLocalDateTime } from "../time";
import { autoReceipt, dayLabel, slotQuestion, splitQuestion } from "../slot-text";
import { joinedSay, placeTask } from "../slots";
import { fullNote, soonestSlot } from "../smart-inbox";
import { wantsSuggestion } from "../smart-inbox-rules";
import type { Interval, SlotOption } from "../routine-rules";
import { attachmentCounts } from "../media";
import { habitsForPrompt } from "../coach";
import { requireDb } from "../db";
import { logEvent } from "../events";
import { logMessage, recentMessages, type Channel } from "../messages";
import { OPEN_STATUSES, type Task } from "../tasks";
import { chat, type ChatMessage } from "./model";
import { buildSystemPrompt, type MemoryFact, type ProjectRef, type ReminderFact } from "./prompt";
import { tidyReply } from "./tidy";
import { asksForReply, asksForTime, claimsAction, clockTimes, isCapture, keepWords, linksIn, notesToKeep, oneQuestion, receiptOnly, statedByHim, unsaved, wantsThought, withoutClaims, withoutInternals, withoutSendClaims, ownWords } from "./reliability";
import { buildPlan } from "../planner";
import { decideFor, getRoutine, nearestFreeFor, taskMinutes } from "../routine";
import { partsOfDay, routineLines } from "../routine-rules";
import { asksToAttachLink, isGenericTitle, refersToLink, titleForLink } from "../link-rules";
import { pageTitle, recentLink } from "../links";
import { runTool, TOOLS } from "./tools";
import { listRules, rulesForPrompt, rulesView } from "../rules";
import { asksForItem, itemRef, libraryCandidates, libraryForPrompt, loadItem } from "../library";
import { itemLabel, type LibraryItem } from "../library-rules";
import { carriesMedia } from "../link-rules";
import { ruleHints } from "../smart-rules";

/** Recent turns sent for context. Each is clipped; old chatter is not worth its tokens. */
const HISTORY = 10;
const HISTORY_CHARS = 1200;
/**
 * A long message is kept by its start and its end: the end is where Tony's own offer or question is
 * (22 Nov 02:28: "Do you want me to turn the weekly rhythm into recurring tasks?" was cut off, so
 * "can u add it to our plan" was not read as a yes, and the PDF was only attached to a task).
 */
export const clip = (text: string) => (text.length > HISTORY_CHARS ? `${text.slice(0, 700).trimEnd()}\n[…]\n${text.slice(-480).trimStart()}` : text);
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

async function loadContext(input: { message?: string; rejected?: string[]; now?: Date } = {}) {
  const db = requireDb();
  const [memory, tasks, projects, settings, habits, routine] = await Promise.all([
    db.from("memory").select("id, fact, layer, goal, mentions, confirmed_at, created_at").order("id"),
    db.from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(60),
    db.from("projects").select("id, name").order("sort_order"),
    db.from("settings").select("last_shared_text, last_shared_at, pending_note, pending_note_at").limit(1).maybeSingle(),
    habitsForPrompt(),
    getRoutine(),
  ]);
  for (const result of [memory, tasks, projects]) {
    if (result.error) throw new Error(`loadContext: ${result.error.message}`);
  }
  const ruleList = await listRules().catch(() => []);
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
    routine: routineLines(routine).join(" · "),
    // What is attached to each open task, so Tony can say what a task holds.
    media: await attachmentCounts(openTasks.map((task) => task.id)),
    // His rules and the newest of his library (phase b), so "that video" and "I'm tired of it all" can be understood.
    ruleList,
    rules: await rulesForPrompt(ruleList).catch(() => undefined),
    library: await libraryForPrompt(input.now ?? new Date(), { message: input.message, rejected: input.rejected }).catch(() => undefined),
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
  options: {
    channel?: Channel;
    now?: Date;
    context?: string;
    /** One of several requests in his message: `text` is this request, `full` the whole message. */
    part?: { index: number; total: number; full: string };
    /** His message is already in the log (an earlier request from it, or a retry). */
    logged?: boolean;
    /** Items he just said are not the one ("no, I didn't mean this one"): never sent again, left out of the list. */
    rejected?: string[];
    /** Times an earlier request in the same message just offered first, kept free for it (21 Nov 22:09: three questions, all "Best: 20:15"). */
    held?: Interval[];
  } = {},
): Promise<{
  reply: string;
  tools: string[];
  titles: string[];
  planId?: number;
  /** Every plan this turn made, one per day, earliest day first ("today and tomorrow": both are shown). */
  planIds?: number[];
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
  /** A day he named without a time: the one slot Tony proposes ([✓] [✏️]), or the free slots to choose from. */
  slot?: Slot;
  /** Something Tony will do once he taps ✓ ("I'll remove Buy notebook"). */
  proposal?: { offerId: number; say: string };
  /** Library items a rule sends him ("media:7", "library:3"). */
  sendItems?: string[];
  /** His rules were shown: their 🗑 buttons go under the reply. */
  showRules?: boolean;
  /** He asked for a file or link and nothing went out: the closest few, one button each ("lib:send:…"). */
  libraryChoices?: { text: string; data: string }[];
  /** The tasks this turn changed. */
  changed?: number[];
  /** Every change was done, dropped or moved, and nothing else happened: its confirmation can go soon. */
  settled?: boolean;
}> {
  const { channel = "telegram", now = new Date(), context: note, part, rejected = [], held = [] } = options;
  const tools: string[] = [];
  // Titles of the tasks the tools touched, so the reply can show them in bold.
  const titles: string[] = [];
  // A plan to show with Apply/Adjust, or a question to show with buttons.
  let planId: number | undefined;
  // One plan per day, the last one made for that day (22 Nov 19:35: "the entire plan for tomorrow and today"
  // made a plan for each day, and only tomorrow's was shown).
  const plansByDay = new Map<string, number>();
  const planIdsOf = () => [...plansByDay].sort(([x], [y]) => x.localeCompare(y)).map(([, id]) => id);
  let choices: { question: string; options: string[] } | undefined;
  // Saved photos or files he asked to see again.
  let mediaIds: number[] | undefined;
  const offerIds: number[] = [];
  // Web pages behind the answer, listed under it as links.
  const sources = new Map<string, string>();
  const fetched: { url: string; title: string }[] = [];
  const [context, history] = await Promise.all([loadContext({ message: text, rejected, now }), recentMessages(HISTORY)]);
  // His message is logged once, whole, even when it is handled request by request.
  if (!options.logged) await logMessage("user", part?.full ?? text, channel);

  const system = buildSystemPrompt({ now, ...context, message: text });
  // What he may be answering: Tony's last message and the post he shared. A time there is one he can say "yes" to.
  const lastTony = [...history].reverse().find((m) => m.role === "tony")?.text ?? "";
  const heard = [lastTony, context.shared?.text].filter(Boolean).join("\n");
  // What he himself said lately: the only source of facts to remember.
  const his = [part?.full ?? text, ...history.filter((m) => m.role === "user").slice(-2).map((m) => m.text)].join("\n");
  // "This one" with nothing replied to: the task touched last in the last 15 minutes (a reminder, or a button he tapped).
  const recent = await recentReminders(now);
  // The request is named word for word, so a sentence inside it is never taken for one of the others
  // (21 Nov 22:09: "…for tomorrow? And I already shoot an app tutorial on Zoom." moved the reel and left the tutorial open).
  const partNote = part
    ? `His message held ${part.total} requests: "${part.full}". This is request ${part.index + 1}: "${text}". Handle everything in it, every sentence (one saying he already did something completes that task), and nothing from the others: each of those is handled on its own.`
    : undefined;
  // His rules his words may fit ("I'm tired, don't want to work out"): a hint; the brain decides.
  const hinted = ruleHints(text, context.ruleList);
  const ruleNote = hinted.length ? `His message may fit his rule${hinted.length > 1 ? "s" : ""} ${hinted.map((rule) => `#${rule.id} (when ${rule.situation.replace(/^when\s+/i, "")})`).join(", ")}: if it does, act on it with rule_fire.` : undefined;
  // "No, I didn't mean this one": what just went out is named, and never sent again (21 Nov 20:21).
  const rejectedItems = rejected.length ? await Promise.all(rejected.map((ref) => loadItem(ref).catch(() => undefined))) : [];
  const rejectedNote = rejected.length
    ? `He says what you just sent (${rejected.map((ref, index) => `${ref}${rejectedItems[index] ? ` "${itemLabel(rejectedItems[index], now)}"` : ""}`).join(", ")}) is NOT the one. Never send it again: pick another from "Fits his words best" or the library list, or ask which with ask, naming them.`
    : undefined;
  const notes = [partNote, note, rejectedNote, ruleNote, note?.includes("He is replying to") ? undefined : recentReminderNote(recent, now)].filter(Boolean).join(" ");
  // A forwarded post or a page he only sent: material, never instructions. Any change it seems to ask for waits for his tap.
  const materialOnly = isMaterialOnly(text) || Boolean(note?.startsWith("He sent a link:"));
  const messages: ChatMessage[] = [
    ...history.map(
      (m): ChatMessage => (m.role === "user" ? { role: "user", content: clip(m.text) } : { role: "assistant", content: clip(m.text) }),
    ),
    // The newest message is marked, so an earlier one is never answered in its place.
    { role: "user", content: latestMessage(text, notes || undefined) },
  ];
  // Several requests, or moving and planning things: the larger model.
  const model = needsDeepModel(text) ? env.anthropicDeepModel : undefined;
  // Advice and discussion get more thought and room for a full answer (Phase 2).
  const depth = wantsThought(text) ? ("deep" as const) : undefined;

  // Every task number the model has seen, so none of them can leak into a reply.
  const taskIds = new Set(context.tasks.map((task) => task.id));
  // What really changed, by task, in order: the reply is built from these, read back from the database.
  const changes = new Map<number, { tool: DoneAction["tool"]; reminder_at?: string; wrote?: Record<string, unknown> }>();
  const saved: string[] = [];
  // Files he filed under a label this turn ("ideas for my reels").
  const filed: string[] = [];
  // Memory notes written or removed this turn, each read back before it is confirmed.
  const remembered: { id: number; fact: string; layer: string; quiet: boolean }[] = [];
  const forgotten: { id: number; fact: string }[] = [];
  // Asked once to save instead of asking for a time he never offered.
  let nudged = false;
  // Tasks for a day he named without a time; check-ins he asked for; routine he told; an action to confirm.
  const dayOnly = new Map<number, string>();
  // Tasks he said the time does not matter for ("no need to add any time"): Tony picks, he is not asked again.
  const picks = new Set<number>();
  const checkIns = new Map<number, number>();
  // A habit ticked off: its streak, read from the log after the tick ("🔥 4 days in a row").
  const streaks = new Map<number, string>();
  const routineSet: { field: string; value: string | null; on?: boolean }[] = [];
  let proposal: { offerId: number; say: string } | undefined;
  const proposals: { offerId: number; say: string }[] = [];
  let askComplete: { taskId: number; title: string } | undefined;
  let reply: string | undefined;
  // Items a rule sends (phase b), rule lines, his rules to show, and a backup-model answer (phase e).
  const sendItems: string[] = [];
  const ruleLines: string[] = [];
  let showRules = false;
  let fellBack: string | undefined;
  // What Tony says as himself alongside the tools (their "reply"): kept above the receipt, never replaced by it (Phase 2).
  const spoken: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await chat({ system, messages, tools: TOOLS, web: true, model, depth });
    if (answer.fallback) fellBack = answer.fallback;
    for (const source of answer.sources ?? []) if (!sources.has(source.url)) sources.set(source.url, source.title);
    for (const page of answer.fetched ?? []) if (!fetched.some((known) => known.url === page.url)) fetched.push(page);
    if (!answer.tool_calls) {
      const content = answer.content ?? "";
      // Act first: a task with no time goes to the inbox; asking for a time he did not offer is not allowed.
      if (!nudged && changes.size === 0 && isCapture(ownWords(text)) && asksForTime(content) && round < MAX_ROUNDS - 1) {
        nudged = true;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "[Do not ask for a time: he gave none, so save it now with add_task and no due_at; it goes to his inbox. Then stop.]" });
        continue;
      }
      reply = tidyReply(content, [...taskIds]);
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
        const name = call.function.name;
        const writes = isWrite(name, args);
        // What he just rejected is never sent again (21 Nov 20:21): the model picks another, or asks.
        const refused = name === "library" && args.action === "send" ? [...(Array.isArray(args.items) ? args.items.map(String) : []), ...(typeof args.item === "string" ? [args.item] : [])].map((ref) => ref.trim()).filter((ref) => rejected.includes(ref)) : [];
        // Deleting or dropping always needs his tap; so does anything a forwarded post or a page seems to ask for (phase e).
        const outcome: Awaited<ReturnType<typeof runTool>> = refused.length
          ? { ok: false, error: `he said ${refused.join(", ")} is not the one: choose another from the list, or ask him which` }
          : needsTap(name, args) || (materialOnly && writes)
            ? await proposeInstead(name, args, now, text, heard)
            : await runTool(name, args, now, text, heard, his);
        for (const match of JSON.stringify(outcome).matchAll(/#(\d+)/g)) taskIds.add(Number(match[1]));
        if (outcome.ok) {
          tools.push(call.function.name);
          if (call.function.name === "plan") {
            planId = Number((outcome as { plan_id?: unknown }).plan_id);
            const planned = String((outcome as { day?: unknown }).day ?? "");
            plansByDay.delete(planned);
            plansByDay.set(planned, planId);
          }
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
          if (call.function.name === "media" && typeof (outcome as { saved_as?: unknown }).saved_as === "string") filed.push(String((outcome as { saved_as?: unknown }).saved_as));
          if (name === "rule_fire" && typeof (outcome as { send_item?: unknown }).send_item === "string") sendItems.push(String((outcome as { send_item?: unknown }).send_item));
          const sending = (outcome as { send_items?: unknown }).send_items;
          if (name === "library" && Array.isArray(sending)) for (const ref of sending) if (!sendItems.includes(String(ref))) sendItems.push(String(ref));
          if (name === "rule") {
            const made = (outcome as { rule?: { situation: string; action: string; item?: string; skip?: string } }).rule;
            if (made) ruleLines.push(`📏 Rule saved: when ${made.situation.replace(/^when\s+/i, "")} → ${made.action}${made.item ? ` · ${made.item}` : ""}${made.skip ? ` _(also after ${made.skip})_` : ""}`);
            if ((outcome as { rule_deleted?: unknown }).rule_deleted) ruleLines.push("🗑 Rule removed.");
            if ((outcome as { show_rules?: unknown }).show_rules) showRules = true;
          }
          // His main priority, read back from what was stored (shown like a rule, under Tony's words).
          if (name === "main_priority") {
            const main = (outcome as { main?: unknown }).main;
            const cleared = (outcome as { main_cleared?: unknown }).main_cleared;
            const others = Array.isArray(main) ? main.length - 1 : 0;
            if (Array.isArray(main) && main.length) ruleLines.push(`⭐ Main priority: **${String(main[0])}**${others === 1 ? " and its other session" : others > 1 ? ` and its ${others} other sessions` : ""} · I'll keep after you until it's done.`);
            if (Array.isArray(cleared)) ruleLines.push(cleared.length ? "⭐ No main priority now." : "⭐ There was no main priority, sir.");
          }
          if (call.function.name === "remember" && Number.isFinite(Number((outcome as { id?: unknown }).id))) {
            const kept = outcome as { id?: unknown; fact?: unknown; layer?: unknown; confirmed?: unknown; changed?: unknown };
            remembered.push({ id: Number(kept.id), fact: String(kept.fact ?? ""), layer: String(kept.layer ?? "always"), quiet: kept.confirmed === true && kept.changed === false });
          }
          if (call.function.name === "forget" && Number.isFinite(Number((outcome as { id?: unknown }).id))) forgotten.push({ id: Number((outcome as { id?: unknown }).id), fact: String((outcome as { forgot?: unknown }).forgot ?? "") });
          const touchedId = Number((outcome as { task_id?: unknown }).task_id);
          const dayAsked = (outcome as { day_only?: unknown }).day_only;
          if (typeof dayAsked === "string" && Number.isFinite(touchedId)) dayOnly.set(touchedId, dayAsked);
          if ((outcome as { tony_picks?: unknown }).tony_picks === true && Number.isFinite(touchedId)) picks.add(touchedId);
          const checkIn = (outcome as { check_in?: { days?: unknown } }).check_in;
          if (checkIn && Number.isFinite(touchedId)) checkIns.set(touchedId, Number(checkIn.days));
          const streak = (outcome as { streak?: unknown }).streak;
          if (typeof streak === "string" && Number.isFinite(touchedId)) streaks.set(touchedId, streak);
          const told = (outcome as { routine?: { field: string; value: string | null; on?: boolean } }).routine;
          if (call.function.name === "routine" && told) routineSet.push(told);
          if ((outcome as { proposal_id?: unknown }).proposal_id !== undefined) proposals.push({ offerId: Number((outcome as { proposal_id?: unknown }).proposal_id), say: String((outcome as { say?: unknown }).say ?? "") });
          if (TASK_TOOLS.has(call.function.name) && Number.isFinite(touchedId)) {
            const reminderAt = (outcome as { reminder_at?: unknown }).reminder_at;
            const tool = (name === "library" ? "update_task" : name) as DoneAction["tool"];
            const wrote = (outcome as { wrote?: unknown }).wrote as Record<string, unknown> | undefined;
            // A task added with its parts in the same turn stays an "add".
            if (!(tool === "subtask" && changes.has(touchedId))) {
              const before = changes.get(touchedId);
              changes.set(touchedId, {
                tool: before?.tool === "add_task" ? "add_task" : tool,
                ...(typeof reminderAt === "string" ? { reminder_at: reminderAt } : before?.reminder_at ? { reminder_at: before.reminder_at } : {}),
                ...(wrote || before?.wrote ? { wrote: { ...before?.wrote, ...wrote } } : {}),
              });
            }
            // Every part ticked: ask before marking the task itself done.
            if (call.function.name === "subtask" && (outcome as { all_done?: unknown }).all_done === true) askComplete = { taskId: touchedId, title: String((outcome as { task?: unknown }).task ?? "") };
          }
          const touched = (outcome as { task?: unknown }).task;
          if (typeof touched === "string") titles.push(touched.replace(/^#\d+\s+/, "").split(" | ")[0]);
          // The model's own words count only where nothing was written; writes are confirmed from the database.
          if (typeof args.reply === "string" && args.reply.trim() && writes && name !== "remember" && !spoken.includes(args.reply.trim())) spoken.push(args.reply.trim());
          if (typeof args.reply === "string" && args.reply.trim() && !writes) prepared = args.reply;
          else if (name === "remember" && typeof args.reply === "string") prepared = withoutClaims(args.reply) || prepared;
          else if (!writes && !showRules) allSucceeded = false; // a lookup: the model must speak next
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
    // Several proposals in one turn are one question with one ✓ (23 Nov 04:18: thirteen removals were
    // proposed, only the last had a button, and his ✓ removed one session of thirteen).
    if (proposals.length > 0 && !proposal) proposal = await joinProposals(proposals);
    // He confirms with ✓ or changes it with ✏️; the words are the proposal itself.
    if (proposal) {
      reply = tidyReply(proposal.say, [...taskIds]) || proposal.say;
      break;
    }
    // Done in one model call: the confirmation is built below from the database.
    if (allSucceeded && (changes.size > 0 || saved.length > 0 || remembered.length > 0 || forgotten.length > 0 || routineSet.length > 0 || ruleLines.length > 0 || showRules || prepared)) {
      if (changes.size === 0 && saved.length === 0 && prepared) reply = tidyReply(prepared, [...taskIds]);
      break;
    }
  }

  // "Send it to me as a preview", "send both": everything kept with that task goes, together; never one of its
  // files alone (22 Nov 01:53: the video went without the photo kept with it). Naming one ("the video") sends that one.
  if (sendItems.length > 0 && wantsWholeTask(ownWords(text)) && !sendItems.some((ref) => ref.startsWith("task:"))) {
    const owners = new Set<number | null>();
    for (const ref of sendItems) owners.add((await loadItem(ref).catch(() => undefined))?.task_id ?? null);
    const [owner] = [...owners];
    if (owners.size === 1 && owner !== null) sendItems.splice(0, sendItems.length, `task:${owner}`);
  }

  // He asked for a file or link (or said the one sent is not it), and nothing went out, nothing was asked,
  // nothing changed: the closest few as buttons, never a second guess (21 Nov 20:21).
  let libraryChoices: { text: string; data: string }[] | undefined;
  const saidNow = ownWords(text);
  if ((asksForItem(saidNow) || rejected.length > 0) && sendItems.length === 0 && !mediaIds?.length && !choices && !proposal && changes.size === 0 && planId === undefined) {
    const candidates = await libraryCandidates(saidNow, now, rejected).catch(() => [] as LibraryItem[]);
    if (candidates.length > 0) {
      libraryChoices = candidates.map((item) => ({ text: itemLabel(item, now).slice(0, 60), data: `lib:send:${itemRef(item)}` }));
      if (!(reply ? withoutSendClaims(withoutInternals(reply)) : "").trim()) reply = "Which one, sir?";
    }
  }

  // The model's own words, before any receipt is added. Nothing about tools, filters or errors;
  // and "Here it is, sir" only when something is really being sent.
  if (reply) {
    const plain = withoutInternals(reply);
    // "Here's your plan" is true when a plan, choices or a proposal is shown: only a file or link that never
    // went out makes "here it is" false (22 Nov 16:15: "Here's your plan for today" became "I couldn't find
    // that one, sir", four times, spoken).
    const showing = Boolean(mediaIds?.length || sendItems.length || planId !== undefined || choices || proposal || libraryChoices);
    const honest = showing ? plain : withoutSendClaims(plain);
    // Nothing left: "I couldn't find that one" only when he asked for a file or a link; otherwise no words.
    if (honest !== reply) reply = honest || (honest !== plain && asksForItem(saidNow) ? "I couldn't find that one, sir." : undefined);
  }

  // He asked whether a link was kept, and the model asks back instead of keeping it: Tony keeps it.
  if (changes.size === 0 && !proposal && reply && asksToAttachLink(reply)) {
    const link = await recentLink(now, history, { minutes: 120 });
    const { data } = await requireDb()
      .from("tasks")
      .select()
      .in("status", OPEN_STATUSES)
      .is("kind", null)
      .gte("updated_at", new Date(now.getTime() - 30 * 60_000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(1);
    const target = ((data ?? []) as Task[])[0];
    if (link && target) {
      const notes = (target.notes ?? "").includes(link.url) ? target.notes : [target.notes, link.url].filter(Boolean).join("\n");
      await requireDb().from("tasks").update({ notes }).eq("id", target.id);
      changes.set(target.id, { tool: "update_task", wrote: { notes: link.url } });
      reply = undefined;
    }
  }

  // The confirmation: what is really stored now, one line per change, read back after every write.
  let clash: Clash | undefined;
  let slot: Slot | undefined;
  const problems: string[] = [];
  if (changes.size > 0) {
    const db = requireDb();
    // A link he sent with this task, or just before it, goes into its notes; a title that says nothing gets the page's.
    const added = [...changes].filter(([, change]) => change.tool === "add_task").map(([id]) => id);
    if (added.length === 1) {
      const row = ((await db.from("tasks").select().eq("id", added[0]).maybeSingle()).data ?? undefined) as Task | undefined;
      const own = linksIn(text)[0];
      // "Watch this" in his own words; a forwarded post that says "watch" is not him pointing at a link.
      const earlier = own || !refersToLink(ownWords(text)) ? undefined : await recentLink(now, history, { lastOnly: true });
      const url = own ?? earlier?.url;
      if (row && url) {
        const patch: Partial<Task> = {};
        if (!(row.notes ?? "").includes(url)) patch.notes = [row.notes, url].filter(Boolean).join("\n");
        if (isGenericTitle(row.title)) {
          const better = titleForLink(row.title, url, earlier?.title ?? (await pageTitle(url)));
          if (better !== row.title) patch.title = better;
        }
        if (Object.keys(patch).length > 0) {
          await db.from("tasks").update(patch).eq("id", row.id);
          const change = changes.get(row.id)!;
          change.wrote = { ...change.wrote, ...(patch.notes ? { notes: url } : {}), ...(patch.title ? { title: patch.title } : {}) };
        }
      }
    }
    // A post or files he forwarded or attached with this request belong to the one task he asked for:
    // kept with it, and sent back with its reminder (21 Nov: "keep the post with the task").
    if (added.length === 1 && carriesMedia(text)) {
      const since = new Date(now.getTime() - 5 * 60_000).toISOString();
      const fresh = (((await db.from("media").select("id, kind").is("task_id", null).gte("created_at", since)).data ?? []) as { id: number; kind: string }[]).filter((item) => item.kind !== "voice" && item.kind !== "audio");
      if (fresh.length) await db.from("media").update({ task_id: added[0] }).in("id", fresh.map((item) => item.id));
      const posts = (((await db.from("library").select("id").eq("kind", "post").is("task_id", null).gte("created_at", since)).data ?? []) as { id: number }[]);
      if (posts.length) await db.from("library").update({ task_id: added[0] }).in("id", posts.map((row) => row.id));
    }
    // Nothing he said is lost: links and details missing from the new tasks go into their notes.
    if (added.length > 0) {
      const rows = ((await db.from("tasks").select().in("id", added)).data ?? []) as Task[];
      const partsOf = await subtasksFor(added);
      // His whole message is quoted into a task's notes only when it was about that one task: copied into
      // each of several tasks it says nothing about any of them (22 Nov: three IELTS sessions, three quotes).
      const keep = notesToKeep(text, rows.map((row) => ({ title: row.title, notes: row.notes, parts: (partsOf.get(row.id) ?? []).map((p) => p.title) })), { quote: rows.length === 1 });
      if (keep) {
        for (const row of rows) {
          const notes = [row.notes, keep].filter(Boolean).join("\n");
          await db.from("tasks").update({ notes }).eq("id", row.id);
          const change = changes.get(row.id)!;
          change.wrote = { ...change.wrote, notes: [change.wrote?.notes, keep].filter(Boolean).join("\n") };
        }
      }
    }
    const { data } = await db.from("tasks").select().in("id", [...changes.keys()]);
    const stored = new Map(((data ?? []) as Task[]).map((task) => [task.id, task]));
    const FIELD: Record<string, string> = { due_at: "time", notes: "notes", title: "title", status: "status", duration_minutes: "length", project_id: "project", priority: "priority" };
    for (const [id, change] of changes) {
      const task = stored.get(id);
      // Notes written in two steps are read back piece by piece.
      const wrote = change.wrote ? { ...change.wrote } : undefined;
      const noteParts = typeof wrote?.notes === "string" ? (wrote.notes as string).split("\n").filter(Boolean) : [];
      if (wrote) delete wrote.notes;
      const missing = wrote ? unsaved(task as unknown as Record<string, unknown> | undefined, wrote) : task ? [] : ["the task"];
      if (task && noteParts.some((piece) => !(task.notes ?? "").includes(piece))) missing.push("notes");
      if (missing.length) problems.push(`⚠️ ${task ? `**${task.title}**: the ${missing.map((field) => FIELD[field] ?? field).join(" and ")} did not save` : "One change did not save"}, sir.`);
      // A heads-up is confirmed only if it is really waiting to go out.
      if (change.reminder_at && task) {
        const waiting = await db.from("reminders").select("id").eq("task_id", id).eq("state", "scheduled").eq("fire_at", change.reminder_at).limit(1);
        if ((waiting.data ?? []).length === 0) {
          problems.push(`⚠️ The reminder for **${task.title}** did not save, sir.`);
          delete change.reminder_at;
        }
      }
      // So is a check-in.
      if (checkIns.has(id) && task) {
        const waiting = await db.from("reminders").select("id").eq("task_id", id).eq("kind", "stale").eq("state", "scheduled").limit(1);
        if ((waiting.data ?? []).length === 0) {
          problems.push(`⚠️ The check-in for **${task.title}** did not save, sir.`);
          checkIns.delete(id);
        }
      }
    }
    // What each task holds, for its receipt: parts, a link, photos and files (read back), notes written now, a check-in.
    const [parts, attached] = await Promise.all([subtasksFor([...changes.keys()]), attachmentCounts([...changes.keys()])]);
    const noteLine = (notes: string) =>
      notes.replace(/https?:\/\/\S+/g, "").replace(/^From your message: /m, "").trim()
        ? notes.split("\n").find((line) => line.trim() && !/^https?:\/\//.test(line.trim()))?.replace(/^From your message: /, "")
        : undefined;
    const marks = (id: number) => {
      const wroteNotes = String(changes.get(id)?.wrote?.notes ?? "");
      const list = parts.get(id);
      return {
        ...(list?.length ? { parts: progress(list) } : {}),
        ...(/https?:\/\//.test(stored.get(id)?.notes ?? "") ? { link: true } : {}),
        ...(attached.has(id) ? { media: attached.get(id) } : {}),
        // The note is read back only when it is his own words ("add a note: the black one"); a note the model wrote
        // from what he shared stays in the task without lengthening the receipt (22 Nov 01:49).
        ...(noteLine(wroteNotes) && statedByHim(noteLine(wroteNotes)!, ownWords(text)) ? { note: noteLine(wroteNotes) } : {}),
        ...(checkIns.has(id) ? { checkIn: checkIns.get(id) } : {}),
        ...(streaks.has(id) ? { streak: streaks.get(id) } : {}),
      };
    };

    // A day he named without a time: ONE question with two or three free slots, best first with its reason (Change 1).
    // Tony picks the slot himself only for a kind he said "decide yourself" for. No day: the inbox, no time proposed.
    const named = new Map(dayOnly);
    const undated = [...changes].filter(([id, change]) => change.tool === "add_task" && stored.get(id) && !stored.get(id)!.due_at && !named.has(id)).map(([id]) => id);
    // The day he named in his own words ("tomorrow"), never one inside a forwarded post.
    const spokenDay = undated.length > 0 && planId === undefined ? (dayFromText(ownWords(text), now) ?? (part ? dayFromText(ownWords(part.full), now) : undefined)) : undefined;
    if (spokenDay) for (const id of undated) named.set(id, localDate(spokenDay));
    for (const [id] of named) if (!stored.get(id) || !OPEN_STATUSES.includes(stored.get(id)!.status)) named.delete(id);
    const decided = new Set<number>();
    const slotLines: string[] = [];
    if (named.size >= 2 && planId === undefined) {
      // Several at once: one plan, one message, [✓ Looks good] [✏️ Change]. Tasks for different days are
      // planned over the week, each on its own day (they were all put on the first day before).
      const days = [...new Set(named.values())].sort();
      const day = parseLocalDateTime(`${days[0]}T12:00`)!;
      const spread = days.length > 1;
      const keepDays = spread ? `Keep each on the day he gave: ${[...named].map(([id, date]) => `#${id} on ${weekdayDate(date)}`).join(", ")}.` : undefined;
      const plan = await buildPlan({
        scope: spread ? "week" : "day",
        now,
        taskIds: [...named.keys()],
        day,
        // No "Here's what I'll do, sir:": nothing is set until he taps ✓, and the plan says so (22 Nov 12:36
        // and 18:53: two proposals read as done, never confirmed; the workouts and "Add them anyway" stayed unset).
        ...(keepDays ? { instructions: keepDays, daysFor: Object.fromEntries(named) } : {}),
      }).catch(
        (error) => (console.error("Plan for new tasks failed:", error), undefined),
      );
      if (plan && "plan" in plan) {
        planId = plan.plan.id;
        reply = "Here is what I propose, sir.";
        await logMessage("tony", reply, channel);
        return { reply, tools, titles, planId, choices, mediaIds, offerIds: offerIds.filter(Number.isFinite), fetched };
      }
    } else if (named.size === 1) {
      const [[id, day]] = [...named];
      const task = stored.get(id)!;
      const decision = await decideFor(task, parseLocalDateTime(`${day}T12:00`)!, now, partsOfDay(part?.full ?? text), held);
      const label = dayLabel(day, now);
      const extra = savedMarks(marks(id));
      decided.add(id);
      // He said the time does not matter for this one ("it doesn't take long so no need to add any time",
      // 21 Nov 20:42): Tony's own pick, never the same question again.
      const pick = decision.decision === "auto" ? decision : decision.decision === "ask" && picks.has(id) && decision.options[0] ? { at: decision.options[0].at, why: decision.options[0].why ?? "the first free time" } : undefined;
      if (pick) {
        // He let Tony decide (for this kind, or for this task): placed at the best slot, and the receipt says it was Tony's pick and why.
        const placed = await placeTask(id, pick.at);
        if (placed.task?.due_at) {
          slot = { kind: "auto", taskId: id, title: placed.task.title, day, at: pick.at, why: pick.why };
          slotLines.push(autoReceipt({ title: placed.task.title, marks: extra, when: formatWhen(pick.at, now).replace(/(\d{2}:\d{2})$/, "**$1**"), why: pick.why }));
        } else problems.push(placed.text);
      } else if (decision.decision === "ask") {
        slot = { kind: "ask", taskId: id, title: task.title, day, options: decision.options, minutes: taskMinutes(task), ...(decision.taken ? { taken: decision.taken } : {}) };
        slotLines.push(slotQuestion({ title: task.title, marks: extra, when: label.when, options: decision.options, taken: decision.taken }));
      } else if (decision.decision === "split") {
        slot = { kind: "split", taskId: id, title: task.title, day, parts: decision.parts, minutes: decision.minutes };
        slotLines.push(splitQuestion({ title: task.title, marks: extra, when: label.when, minutes: decision.minutes, total: task.duration_minutes ?? decision.minutes * 2, parts: decision.parts }));
      } else {
        slotLines.push(`✓ **${task.title}** in the inbox${extra}: ${label.plain} is full, sir.`);
      }
    } else if (named.size === 0 && undated.length === 1 && planId === undefined && wantsSuggestion(ownWords(text))) {
      // The smart inbox (Phase I, 23 Nov: "suggest me a specific time. Then I just click and it saves until that
      // day"): a new thing with no day gets the first day that is not full, at its best free time. Nothing is
      // set until he taps; [📅 Later day] looks further on, [📥 Inbox] leaves it unplanned.
      const id = undated[0];
      const task = stored.get(id)!;
      const suggestion = task.status === "inbox" && !task.free_time ? await soonestSlot(task, now).catch((error) => (console.error("Smart inbox:", error), undefined)) : undefined;
      if (suggestion) {
        decided.add(id);
        slot = { kind: "ask", taskId: id, title: task.title, day: suggestion.day, options: suggestion.options, inbox: true, minutes: taskMinutes(task) };
        slotLines.push(slotQuestion({ title: task.title, marks: savedMarks(marks(id)), when: dayLabel(suggestion.day, now).when, options: suggestion.options, note: fullNote(suggestion.full, now) || undefined }));
      }
    }

    const done: DoneAction[] = [...changes].flatMap(([id, change]) => {
      const task = stored.get(id);
      if (!task || decided.has(id)) return [];
      // A new title: the receipt says what it was, so "change this title to …" reads back the change.
      const before = context.tasks.find((known) => known.id === id)?.title;
      const renamed = change.tool === "update_task" && before && before !== task.title && typeof change.wrote?.title === "string" ? before : undefined;
      return [
        {
          tool: change.tool,
          title: task.title,
          ...(renamed ? { renamedFrom: renamed, dueChanged: "due_at" in (change.wrote ?? {}) } : {}),
          status: task.status,
          due_at: task.due_at,
          free_time: task.free_time,
          repeat: task.repeat_rule,
          repeat_until: task.repeat_until ?? null,
          ...(change.reminder_at ? { reminder_at: change.reminder_at } : {}),
          ...marks(id),
        },
      ];
    });
    const confirmation = done.length ? confirmationFor(done, now, ownWords(text)) : "";
    // If something failed, the model's own words explain it (never claiming anything); the confirmation shows what did happen.
    // His own words first (kept as he said them, less any claim, wrong time or internals), then the receipt from what is stored.
    const known = [text, confirmation, ...slotLines, context.prayers ?? "", ...context.tasks.map((task) => (task.due_at ? formatTime(new Date(task.due_at)) : ""))].join(" ");
    const kept = keepWords(tidyReply([...spoken, reply ?? ""].filter(Boolean).join("\n\n"), [...taskIds]), { times: clockTimes(known) });
    // A plain request (add, move, remind, attach, remember) gets the receipt alone; a comment only when he asked for one.
    // A plan made of several tasks keeps Tony's line on what today holds.
    const plainRequest = sendItems.length === 0 && changes.size < 3 && tools.every((name) => CAPTURE_TOOLS.has(name)) && !asksForReply(ownWords(text));
    const words = plainRequest ? receiptOnly(kept) : kept;
    // A question of his own does not stand next to Tony's question about the slot.
    const tonyWords = slotLines.length && slot && slot.kind !== "auto" ? words.replace(/[^.?!\n]*\?+/g, "").trim() : words;
    reply = [tonyWords, confirmation, ...slotLines, ...problems].filter(Boolean).join("\n\n");
    // Only a time set in this turn can make a clash worth saying (adding a video to a task makes none).
    clash = await findClash([...stored.values()].filter((task) => !decided.has(task.id) && changes.get(task.id)?.wrote?.due_at !== undefined), now);
    if (askComplete && stored.get(askComplete.taskId)?.status === "done") askComplete = undefined;
    if (askComplete) reply = `${reply}\n\nEvery part of **${askComplete.title}** is done, sir. Mark the task itself done?`;
    // A clash is stated, never asked about: the buttons offer the move.
    if (clash) reply = `${reply}\n\n⚠️ ${clash.sentence}.`;
  }
  if (routineSet.length > 0) {
    const label: Record<string, string> = { wake: "Wake", sleep: "Sleep", teaching: "Teaching", content: "Content", coding: "Coding", workout: "Workout", free_days: "Free days" };
    const lines = routineSet
      .map((item) =>
        item.field === "decide" ? (item.on === false ? `🗓 Asking you again for: ${item.value}` : `🗓 Tony picks the time for: ${item.value}`) : `🗓 ${label[item.field] ?? item.field}: ${item.value ?? "not set"}`,
      )
      .join("\n");
    reply = reply && changes.size > 0 ? `${reply}\n${lines}` : `${lines}\nNoted in your routine.`;
  }
  if (saved.length > 0) {
    // Read back: a bookmark is confirmed only once it is in his library.
    const { data } = await requireDb().from("library").select("title").order("id", { ascending: false }).limit(50);
    const kept = ((data ?? []) as { title: string | null }[]).map((row) => row.title ?? "");
    const lines = saved.map((title) => (kept.some((known) => known.includes(title) || title.includes(known)) ? `💾 Saved to your library: **${title}**` : `⚠️ **${title}** did not save, sir.`)).join("\n");
    reply = reply ? `${reply}\n${lines}` : `${lines}. Ask me for it any time.`;
  }
  if (filed.length > 0) {
    // Where it went and how to get it back, in one line (21 Nov: "how did it save it?").
    const lines = filed.map((label) => `💾 Kept in your library as **${label}** · get it back with /library or "send me ${label}"`).join("\n");
    reply = reply ? `${reply}\n${lines}` : lines;
  }
  // A note he only repeated is confirmed quietly; a new note, a new layer or a new goal gets its receipt.
  const told = remembered.filter((note) => !note.quiet);
  if (told.length > 0 || forgotten.length > 0) {
    const ids = [...told, ...forgotten].map((note) => note.id);
    const { data } = await requireDb().from("memory").select("id").in("id", ids);
    const present = new Set(((data ?? []) as { id: number }[]).map((row) => Number(row.id)));
    const lines = [
      ...told.map((note) => (present.has(note.id) ? `📝 ${note.layer === "week" ? "This week" : note.layer === "month" ? "This month" : "Remembered"}: ${note.fact}` : `⚠️ I could not keep that note, sir.`)),
      ...forgotten.map((note) => (present.has(note.id) ? `⚠️ I could not forget that note, sir.` : `🗑 Forgotten: ${note.fact}`)),
    ].join("\n");
    reply = reply ? `${withoutClaims(reply) || ""}\n${lines}`.trim() : lines;
  }
  // A rule saved or removed (phase b), read back by the tool; his rules shown with their 🗑 buttons.
  if (ruleLines.length > 0) reply = reply ? `${withoutClaims(reply) || ""}\n${ruleLines.join("\n")}`.trim() : ruleLines.join("\n");
  if (showRules) reply = [reply && !claimsAction(reply) ? reply : undefined, (await rulesView(now)).text].filter(Boolean).join("\n\n");
  // Nothing was written, yet the words say it was: those words go.
  const wroteSomething = changes.size > 0 || saved.length > 0 || remembered.length > 0 || forgotten.length > 0 || routineSet.length > 0 || ruleLines.length > 0 || sendItems.length > 0 || showRules || proposal !== undefined || tools.includes("media") || tools.includes("offer_task");
  if (!wroteSomething && reply && claimsAction(reply)) reply = withoutClaims(reply) || "Nothing has been changed yet, sir. Could you say that once more?";
  // One question at most.
  if (reply) reply = oneQuestion(reply);

  reply ||= "My apologies, sir. I lost my thread there; could you say that once more?";
  // Never a silent downgrade (phase e): an answer from the backup model says so.
  if (fellBack) reply = `${reply}\n\n_(Answered by the backup model: Claude was unavailable.)_`;
  // Cited web pages, as links under the answer (a page he sent himself is not listed back to him).
  const listed = [...sources].filter(([url]) => !fetched.some((page) => page.url === url) && !reply!.includes(url)).slice(0, 4);
  if (listed.length > 0) reply = `${reply}\n\n**Sources**\n${listed.map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`).join("\n")}`;
  await logMessage("tony", reply, channel);
  // Only done, dropped or moved: the confirmation goes from the chat soon after (22 Nov: "after i complete
  // the task ... chat is getting worse"). Anything added, noted or asked keeps the usual hours.
  const settling = (change: { tool: DoneAction["tool"]; wrote?: Record<string, unknown> }) =>
    change.tool === "complete_task" || (change.tool === "update_task" && Boolean(change.wrote) && Object.keys(change.wrote!).every((key) => ["status", "due_at", "day"].includes(key)));
  const settled = changes.size > 0 && [...changes.values()].every(settling) && saved.length + remembered.length + forgotten.length + routineSet.length + ruleLines.length === 0 && !clash && !slot && !proposal;
  return { reply, tools, titles, planId, ...(plansByDay.size > 1 ? { planIds: planIdsOf() } : {}), choices, mediaIds, offerIds: offerIds.filter(Number.isFinite), fetched, clash, askComplete, slot, proposal, sendItems, showRules, libraryChoices, changed: [...changes.keys()], settled };
}

/** A day he named, without a time: he is asked (best first), Tony's own pick for an "auto" kind, or two halves offered. */
export type Slot =
  | { kind: "ask"; taskId: number; title: string; day: string; options: SlotOption[]; taken?: string; minutes?: number; inbox?: boolean }
  | { kind: "auto"; taskId: number; title: string; day: string; at: Date; why: string }
  | { kind: "split"; taskId: number; title: string; day: string; parts: Date[]; minutes: number };

export { dayLabel };

/** Tools that write: their success is read back from the database before it is confirmed. */
const WRITES = new Set(["add_task", "update_task", "complete_task", "set_reminder", "subtask", "remember", "forget", "save_link", "routine", "main_priority"]);

const TASK_TOOLS = new Set(["add_task", "update_task", "complete_task", "set_reminder", "subtask", "library"]);
/** "As a preview", "both", "everything", "all the files": he wants all that is kept with the task, not one file. */
export const wantsWholeTask = (said: string) => /\b(previews?|both|everything|all of (it|them)|all (the |its |my )?(files|materials?|attachments|examples|photos|videos|pictures))\b/i.test(said);

/** Tools that only file or change what he asked for: a turn made only of these is a plain request. */
const CAPTURE_TOOLS = new Set(["add_task", "update_task", "complete_task", "set_reminder", "subtask", "library", "remember", "forget", "media", "main_priority"]);

/** A call that changes something: the write tools, a library attach, a rule added or removed. */
function isWrite(name: string, args: Record<string, unknown>): boolean {
  return WRITES.has(name) || (name === "library" && args.action === "attach") || (name === "rule" && args.action !== "list");
}

/** Deleting or dropping anything waits for his tap (phase e): a task dropped, a memory note forgotten, a part removed, a rule deleted. */
function needsTap(name: string, args: Record<string, unknown>): boolean {
  return (name === "update_task" && args.status === "dropped") || name === "forget" || (name === "subtask" && args.action === "remove") || (name === "rule" && args.action === "delete");
}

/** A forwarded post or a shared item with none of his own words: material, never instructions (phase e). */
export function isMaterialOnly(text: string): boolean {
  if (!/^\s*\[He (forwarded this to you|sent you a)/.test(text)) return false;
  const own = text.replace(/«««[\s\S]*?»»»/g, " ").replace(/^\s*\[He [^\]]*\]\s*$/gm, " ").replace(/^(Text in the image:|Shows:|Post forwarded from|A (photo|video|file|post)|\(Saved)[^\n]*$/gm, " ");
  return own.trim().length === 0;
}

/** The change, offered with [✓ Do it] [✏️ Change] instead of made: "I'll drop **Buy notebook**." */
async function proposeInstead(name: string, args: Record<string, unknown>, now: Date, said: string, heard: string) {
  const db = requireDb();
  const taskId = Number(args.id ?? args.task_id);
  const task = Number.isSafeInteger(taskId) ? ((await db.from("tasks").select("title").eq("id", taskId).maybeSingle()).data as { title: string } | null) : null;
  let say: string;
  if (name === "update_task" && args.status === "dropped") say = `I'll drop **${task?.title ?? "that task"}**.`;
  else if (name === "forget") {
    const fact = (await db.from("memory").select("fact").eq("id", Number(args.id)).maybeSingle()).data as { fact: string } | null;
    say = `I'll forget: "${fact?.fact ?? "that note"}".`;
  } else if (name === "subtask") say = `I'll remove ${Array.isArray(args.titles) ? args.titles.map((t) => `"${t}"`).join(", ") : "that part"} from **${task?.title ?? "the task"}**.`;
  else if (name === "rule") say = `I'll remove rule #${args.id}.`;
  else if (name === "add_task") {
    const due = typeof args.due_at === "string" ? parseLocalDateTime(args.due_at) : undefined;
    say = `I'll add **${String(args.title ?? "it")}**${due ? ` for ${formatWhen(due, now).replace(/(\d{2}:\d{2})$/, "**$1**")}` : ""}.`;
  }
  else if (name === "update_task") say = `I'll change **${task?.title ?? "that task"}** as that post suggests.`;
  else say = "I'll do what that post asks.";
  return runTool("propose", { say, tool: name, args }, now, said, heard);
}

/** "Mon 23 Nov" for "2026-11-23". */
const weekdayDate = (date: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", weekday: "short", day: "numeric", month: "short" }).format(parseLocalDateTime(`${date}T12:00`)!).replace(",", "");

/** Two tasks at their times, the same whichever is named first. */
const clashKey = (a: Pick<Task, "id" | "due_at">, b: Pick<Task, "id" | "due_at">) =>
  [a, b]
    .sort((x, y) => x.id - y.id)
    .map((task) => `${task.id}@${task.due_at ? new Date(task.due_at).toISOString() : ""}`)
    .join("|");

/** A clash a change created, and where the changed task could go instead. */
export type Clash = { taskId: number; title: string; sentence: string; suggestAt?: Date };

/** Checks each changed, open, timed task against the rest of the list (±30 min, or by duration). */
async function findClash(changed: Task[], now: Date): Promise<Clash | undefined> {
  const timed = changed.filter((task) => task.due_at && OPEN_STATUSES.includes(task.status) && task.kind !== "prayer");
  if (timed.length === 0) return undefined;
  const { data, error } = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).not("due_at", "is", null).gte("due_at", now.toISOString());
  if (error) return undefined;
  const others = (data ?? []) as Task[];
  // A clash is told once: the same two tasks at the same times are not flagged again (22 Nov 01:49–01:53: three times in four minutes).
  const told = await requireDb().from("events").select("detail").eq("kind", "clash_told").gte("created_at", new Date(now.getTime() - 24 * 60 * 60_000).toISOString()).limit(100);
  const toldKeys = new Set(((told.data ?? []) as { detail: { key?: string } }[]).map((row) => row.detail?.key));
  for (const task of timed) {
    const clashing = clashesWith(task, others).filter((other) => !toldKeys.has(clashKey(task, other)));
    if (clashing.length === 0) continue;
    await logEvent("clash_told", { key: clashKey(task, clashing[0]) });
    // The nearest time that is really free for its whole length, in his waking hours and out of his teaching hours.
    const free = await nearestFreeFor(task, new Date(task.due_at!), now).catch(() => undefined);
    const suggestAt = free && free.getTime() !== new Date(task.due_at!).getTime() ? free : undefined;
    return { taskId: task.id, title: task.title, sentence: clashSentence(clashing[0], task), suggestAt };
  }
  return undefined;
}

/** Reminders sent in the last 15 minutes, with their tasks' titles. */
/** What happened to his tasks in the last 15 minutes: reminders sent, and buttons he tapped (Start, Done, a move). */
async function recentReminders(now: Date): Promise<Touch[]> {
  const db = requireDb();
  const since = new Date(now.getTime() - 15 * 60_000).toISOString();
  const [sent, taps] = await Promise.all([
    db.from("reminders").select("task_id, sent_at").in("state", ["sent", "acknowledged"]).gte("sent_at", since),
    db.from("events").select("kind, detail, created_at").in("kind", ["task_tap", "freetime_answer"]).gte("created_at", since),
  ]);
  const tapped = ((taps.data ?? []) as { kind: string; detail: { task_id?: number; action?: string; answer?: string } | null; created_at: string }[])
    .filter((row) => Number.isFinite(Number(row.detail?.task_id)))
    .map((row): Omit<Touch, "title"> => {
      const action = row.kind === "freetime_answer" ? (row.detail?.answer === "now" ? "start" : "later") : String(row.detail?.action ?? "");
      return { task_id: Number(row.detail!.task_id), sent_at: row.created_at, how: action === "start" ? "started" : action === "done" ? "done" : "moved" };
    });
  const rows = [...((sent.data ?? []) as { task_id: number | null; sent_at: string }[]).filter((row) => row.task_id !== null).map((row) => ({ ...row, how: "reminded" as const })), ...tapped];
  if (rows.length === 0) return [];
  const tasks = await db.from("tasks").select("id, title, kind, status").in("id", [...new Set(rows.map((row) => row.task_id!))]);
  // A task he already ticked off is not what "it" means any more (unless he just ticked it with a button).
  const known = (tasks.data ?? []) as { id: number; title: string; kind: string | null; status: string }[];
  const byId = new Map(known.filter((task) => task.kind !== "prayer").map((task) => [task.id, task]));
  return rows
    .filter((row) => byId.has(row.task_id!) && (row.how === "done" || OPEN_STATUSES.includes(byId.get(row.task_id!)!.status as Task["status"])))
    .map((row) => ({ ...row, title: byId.get(row.task_id!)!.title }));
}

/** Several proposals made in one turn, as one: "I'll drop these 3: A, B, C." with one ✓ that runs them all. */
async function joinProposals(list: { offerId: number; say: string }[]): Promise<{ offerId: number; say: string }> {
  if (list.length === 1) return list[0];
  const say = joinedSay(list.map((item) => item.say));
  const { data, error } = await requireDb().from("offers").insert({ kind: "action", payload: { say, tool: "batch", args: { offers: list.map((item) => item.offerId) } } }).select("id").single();
  if (error || !data) return list[list.length - 1];
  return { offerId: (data as { id: number }).id, say };
}

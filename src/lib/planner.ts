import { currentGoals, isAlive, normalNote } from "./memory-rules";
import { LATE_LEAD, allClashes, clashSentence, planDay } from "./brain/checks";
import { busyIntervals, dayWindow, estimateMinutes, isDeep, placeAll, type Busy as Booked, type ToPlace } from "./schedule";
import "server-only";
import { InlineKeyboard } from "grammy";
import { chat, type ToolDefinition } from "./brain/model";
import { requireDb } from "./db";
import { b, code, esc, expandable, i } from "./html";
import { scheduleReminder } from "./reminders";
import { getSettings } from "./settings";
import { clockOf, OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, localDate, parseClock, parseLocalDateTime, TIMEZONE } from "./time";
import { getRoutine } from "./routine";
import { blockedRanges, kindOf, preferredRanges, routineLines } from "./routine-rules";

/**
 * Tony's planner. Given what is waiting (overdue and inbox tasks), what is
 * already fixed in the calendar, and what he knows about his owner's habits,
 * it proposes a time for each task and says why.
 *
 * The AI model proposes; this code decides. Every proposed time is checked
 * against the day's limits and the fixed events and moved to the nearest
 * free slot if it clashes, so a plan can never double-book or land in the
 * past. If the model is unavailable, a rule-based fallback fills the slots.
 * Nothing is changed until the plan is applied.
 */
export type PlanItem = { task_id: number; title: string; at: string; why: string };
export type PlanLeftOut = { task_id: number; title: string; why: string };
export type Plan = {
  id: number;
  scope: "day" | "week";
  day: string;
  items: PlanItem[];
  left_out: PlanLeftOut[];
  why: string;
  planned_by: "model" | "rules";
  status: "proposed" | "applied" | "dismissed";
  message_id: number | null;
  created_at: string;
  applied_at: string | null;
  /** A line above the plan ("Today is nearly over, sir — here's tomorrow."). */
  lead?: string | null;
  /** A one-line proposal for tasks he just gave without times. */
  compact?: boolean;
};

const MINUTE = 60_000;
/** Each task is given an hour; two things may not start within an hour of each other. */
const BLOCK_MINUTES = 60;
const STEP_MINUTES = 15;
const DAY_STARTS = 8 * 60;
const MAX_PER_DAY = 5;

type Busy = { at: Date; title: string };
type Window = { start: Date; end: Date };
type Proposal = { id: number; at?: Date; why: string };

const weekdayOf = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "long" }).format(at);
const shortDay = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
const snap = (at: Date) => new Date(Math.ceil(at.getTime() / (STEP_MINUTES * MINUTE)) * STEP_MINUTES * MINUTE);

/** The hours of a day in which Tony will put things: 08:00 until an hour before quiet hours. */
export function windowOf(day: Date, quietStart: string): Window {
  const { start } = dayBounds(day);
  const quiet = parseClock(quietStart);
  const endMinute = quiet > 12 * 60 ? quiet - 60 : 22 * 60;
  return { start: addMinutes(start, DAY_STARTS), end: addMinutes(start, endMinute) };
}

const clashes = (at: Date, busy: Busy[]) => busy.some((other) => Math.abs(other.at.getTime() - at.getTime()) < BLOCK_MINUTES * MINUTE);

/** The first free start time at or after `from`, within the given days' windows. */
export function nextFree(from: Date, busy: Busy[], windows: Window[], earliest: Date): Date | undefined {
  for (const window of windows) {
    if (from.getTime() > window.end.getTime()) continue;
    let at = snap(new Date(Math.max(from.getTime(), window.start.getTime(), earliest.getTime())));
    for (; at.getTime() <= window.end.getTime(); at = addMinutes(at, STEP_MINUTES)) {
      if (!clashes(at, busy)) return at;
    }
  }
  return undefined;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []);

/** A habit he told Tony that bears on this task and names a time of day. */
function habitFor(title: string, memory: string[]): { fact: string; minute: number } | undefined {
  // Compared by their first four letters, so "workout" meets "works out" and "reading" meets "read".
  const stems = (text: string) => new Set([...words(text)].map((word) => word.slice(0, 4)));
  const wanted = stems(title);
  for (const fact of memory) {
    const lower = fact.toLowerCase();
    const related = [...stems(fact)].some((stem) => wanted.has(stem));
    if (!related) continue;
    const clock = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (clock) return { fact, minute: Number(clock[1]) * 60 + Number(clock[2]) };
    if (/morning/.test(lower)) return { fact, minute: 9 * 60 };
    if (/afternoon|lunch/.test(lower)) return { fact, minute: 14 * 60 };
    if (/evening|after work/.test(lower)) return { fact, minute: 18 * 60 };
    if (/night/.test(lower)) return { fact, minute: 20 * 60 };
  }
  return undefined;
}

const PROPOSE: ToolDefinition = {
  type: "function",
  function: {
    name: "propose",
    description: "Give the schedule.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              date: { type: "string", description: "YYYY-MM-DD" },
              time: { type: "string", description: "HH:MM" },
              why: { type: "string", description: "Why then, in at most 12 words, addressed to him." },
            },
            required: ["id", "date", "time", "why"],
          },
        },
        left_out: {
          type: "array",
          items: { type: "object", properties: { id: { type: "integer" }, why: { type: "string" } }, required: ["id", "why"] },
        },
        why: { type: "string", description: "One sentence on the plan as a whole." },
      },
      required: ["items", "why"],
    },
  },
};

/** Asks the model where things should go. Its answer is only a proposal. */
async function modelProposal(input: {
  now: Date;
  days: Date[];
  windows: Window[];
  fixed: Busy[];
  candidates: Task[];
  memory: string[];
  instructions?: string;
  all?: boolean;
}): Promise<{ proposals: Proposal[]; leftOut: Map<number, string>; why: string }> {
  const { now, days, windows, fixed, candidates, memory, instructions, all } = input;
  const describe = (task: Task) => {
    const state = task.due_at ? `overdue since ${shortDay(new Date(task.due_at))} ${formatTime(new Date(task.due_at))}` : `in the inbox ${Math.floor((now.getTime() - new Date(task.created_at).getTime()) / (24 * 60 * MINUTE))} days`;
    return `#${task.id} ${task.title} | ${state} | P${task.priority}${task.persistent ? " | important" : ""}`;
  };
  const system = [
    "You schedule tasks for Behruzbek, an English teacher and content creator in Tashkent. Choose a day and start time for each task.",
    all
      ? `Rules: only between ${formatTime(windows[0].start)} and ${formatTime(windows[0].end)}; nothing before the current time; never at the same time as a fixed event or another task. He asked for all of them: place every task, with no limit per day; leave one out only when no free time is left.`
      : `Rules: only between ${formatTime(windows[0].start)} and ${formatTime(windows[0].end)}; nothing before the current time; never within an hour of a fixed event or of another task; at most ${MAX_PER_DAY} new tasks a day.`,
    `Follow his habits where one applies. Put first, and earliest in the day, tasks that serve one of his goals (lines starting 'Goal'), then urgent (P1, P2) and overdue tasks.${all ? "" : " If a task does not fit, leave it out and say why."}`,
    "Each reason is short, plain, and addressed to him: 'you work out in the evenings', 'free hour after classes'. A reason never says 'today' for another day: name the day ('Monday is full').",
  ].join(" ");
  const user = [
    `Now: ${weekdayOf(now)} ${localDate(now)} ${formatTime(now)}.`,
    `Days to plan: ${days.map((day) => `${weekdayOf(day)} ${localDate(day)}`).join(", ")}.`,
    `His habits:\n${memory.length ? memory.map((fact) => `- ${fact}`).join("\n") : "(none recorded)"}`,
    `Fixed events:\n${fixed.length ? fixed.map((event) => `- ${localDate(event.at)} ${formatTime(event.at)} ${event.title}`).join("\n") : "(none)"}`,
    `Tasks to place:\n${candidates.map(describe).join("\n")}`,
    instructions ? `His instructions: ${instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const answer = await chat({ system, messages: [{ role: "user", content: user }], tools: [PROPOSE], force: "propose" });
  const call = answer.tool_calls?.find((entry) => entry.function.name === "propose");
  if (!call) throw new Error("the model did not return a schedule");
  const args = JSON.parse(call.function.arguments || "{}") as {
    items?: { id?: number; date?: string; time?: string; why?: string }[];
    left_out?: { id?: number; why?: string }[];
    why?: string;
  };
  const proposals: Proposal[] = [];
  for (const item of args.items ?? []) {
    const at = item.date && item.time ? parseLocalDateTime(`${item.date}T${item.time.slice(0, 5)}`) : undefined;
    if (typeof item.id === "number") proposals.push({ id: item.id, at, why: String(item.why ?? "").slice(0, 140) });
  }
  const leftOut = new Map((args.left_out ?? []).filter((entry) => typeof entry.id === "number").map((entry) => [entry.id!, String(entry.why ?? "").slice(0, 140)]));
  return { proposals, leftOut, why: String(args.why ?? "").slice(0, 300) };
}

/** The fallback when the model cannot be reached: habits first, then the first free slot. */
function rulesProposal(candidates: Task[], memory: string[], days: Date[]): { proposals: Proposal[]; leftOut: Map<number, string>; why: string } {
  const proposals = candidates.map((task): Proposal => {
    const habit = habitFor(task.title, memory);
    if (!habit) return { id: task.id, why: task.due_at ? "overdue, so the first free slot" : "the first free slot" };
    return { id: task.id, at: addMinutes(dayBounds(days[0]).start, habit.minute), why: `you told me: "${habit.fact}"` };
  });
  return { proposals, leftOut: new Map(), why: "Urgent and overdue tasks first, each in the first free hour, keeping to the habits you have told me." };
}

export type PlanResult = { plan: Plan } | { nothing: string; full?: boolean };

type PlanOptions = {
  scope: "day" | "week";
  day?: Date;
  instructions?: string;
  now?: Date;
  /** Plan only these tasks (ones he just gave without times), as a compact proposal. */
  taskIds?: number[];
  /** A line to show above the plan. */
  lead?: string;
  /** The day he gave each task (YYYY-MM-DD by task id): it is placed on that day only. */
  daysFor?: Record<number, string>;
  /** He named this day ("today", "22 November"): it is planned, never swapped for tomorrow or a later day. */
  exactDay?: boolean;
  /**
   * He asked for every waiting task ("schedule all the tasks", "add them anyway"): no limit of five a day,
   * and a task is left out only when no free time is left (22 Nov 18:52: three left out "Only 5 tasks fit
   * in a day", and "Add them anyway for tomorrow").
   */
  all?: boolean;
};

/**
 * The free minutes left in today's waking hours from 15 minutes on, by what
 * is really booked: each task for its own length, prayers ±15 minutes, and
 * tasks at the same time counted once. (22 Nov 16:15: every task counted as a
 * full hour, three at 20:15 as three, so "Today is nearly over, sir" came at
 * 16:15 with five free hours left.)
 */
export function freeMinutesLeft(now: Date, window: { start: Date; end: Date }, tasks: Booked[]): number {
  const from = Math.max(now.getTime() + 15 * MINUTE, window.start.getTime());
  const to = window.end.getTime();
  if (to <= from) return 0;
  const busy = busyIntervals(tasks)
    .map((interval) => ({ start: Math.max(interval.start, from), end: Math.min(interval.end, to) }))
    .filter((interval) => interval.end > interval.start)
    .sort((x, y) => x.start - y.start);
  let taken = 0;
  let reach = from;
  for (const interval of busy) {
    const start = Math.max(interval.start, reach);
    if (interval.end > start) taken += interval.end - start;
    reach = Math.max(reach, interval.end);
  }
  return Math.max(0, (to - from - taken) / MINUTE);
}

/**
 * Proposes a plan. Asked for the day without naming it when it is nearly over (from 20:00,
 * or from 17:00 with under an hour free), it plans tomorrow and says so; a day with
 * no free hour rolls on to the next, so the answer is never just "no free
 * hour left".
 */
export async function buildPlan(options: PlanOptions): Promise<PlanResult> {
  const now = options.now ?? new Date();
  let day = options.day ?? now;
  let lead: string | undefined = options.lead;
  // Asked for today without naming it, late (after 20:00, or under two free hours left by what is really
  // booked): tomorrow, and it says so. Today he named is today, whatever the hour.
  if (options.scope === "day" && localDate(day) === localDate(now) && !options.exactDay) {
    const settings = await getSettings();
    const window = windowOf(now, settings.quiet_start);
    const { data } = await requireDb().from("tasks").select("due_at, duration_minutes, kind, status, title, anytime").in("status", OPEN_STATUSES).gte("due_at", window.start.toISOString()).lt("due_at", window.end.toISOString());
    const freeMinutes = freeMinutesLeft(now, window, (data ?? []) as Booked[]);
    if (planDay(now, freeMinutes) === "tomorrow") {
      day = dayBounds(addMinutes(now, 24 * 60)).start;
      lead = options.lead ? `${options.lead} ${LATE_LEAD.replace(/^Today is nearly over, sir — /, "today is nearly over, so ")}` : LATE_LEAD;
    }
  }
  for (let attempt = 0; attempt < (options.scope === "day" ? 7 : 1); attempt++) {
    const result = await planFor({ ...options, day, now }, lead);
    // The day he named and nothing fits: that is the answer, not another day he did not ask for.
    if ("plan" in result || !result.full || options.exactDay) return result;
    const full = localDate(day) === localDate(now) ? "Today" : weekdayOf(day);
    day = dayBounds(addMinutes(day, 24 * 60 + 12 * 60)).start;
    lead = `${full} is full, sir — here's ${weekdayOf(day)}.`;
  }
  return { nothing: "There is no free hour in the coming week." };
}

/**
 * Proposes a plan for one day (or the week from it). Stored as 'proposed';
 * applyPlan makes it real.
 */
async function planFor(options: PlanOptions, lead?: string): Promise<PlanResult> {
  const db = requireDb();
  const now = options.now ?? new Date();
  const first = options.day ?? now;
  const routine = await getRoutine();
  const days = Array.from({ length: options.scope === "week" ? 7 : 1 }, (_, n) => addMinutes(first, n * 24 * 60));
  // His waking day, from his routine (07:00 to 23:00 unless he said otherwise).
  const windows = days.map((day) => dayWindow(day, routine.sleep, routine.wake));
  const earliest = snap(addMinutes(now, 15));

  const [taskRows, memoryRows, projectRows] = await Promise.all([
    // Drafts (tasks he just gave, not yet confirmed) are included only when planning those.
    db.from("tasks").select().in("status", options.taskIds ? [...OPEN_STATUSES, "draft"] : OPEN_STATUSES).limit(500),
    db.from("memory").select("id, fact, layer, goal, mentions, confirmed_at, created_at").order("id"),
    db.from("projects").select("id, name"),
  ]);
  const projectName = new Map(((projectRows.data ?? []) as { id: number; name: string }[]).map((project) => [project.id, project.name]));
  if (taskRows.error || memoryRows.error) throw new Error(`buildPlan: ${(taskRows.error ?? memoryRows.error)!.message}`);
  const tasks = taskRows.data as Task[];
  // What the planner knows of his days: his routine first, then what he has told Tony.
  const notes = ((memoryRows.data ?? []) as Parameters<typeof normalNote>[0][]).map(normalNote).filter((note) => isAlive(note, now));
  // His goals right now (this week, this month): what the plan serves first.
  const goals = currentGoals(notes, now).map((note) => `Goal (${note.layer === "week" ? "this week" : "this month"}): ${note.fact}`);
  const memory = [...routineLines(routine).map((line) => `Routine: ${line}`), ...goals, ...notes.filter((note) => !note.goal).map((note) => note.fact)];

  // Fixed: anything that already has a time still ahead in the days being planned.
  const horizonEnd = dayBounds(days[days.length - 1]).end.getTime();
  const fixed: Busy[] = tasks
    .filter((task) => task.due_at && !task.anytime && new Date(task.due_at).getTime() >= now.getTime() && new Date(task.due_at).getTime() < horizonEnd)
    .map((task) => ({ at: new Date(task.due_at!), title: task.title }));

  // To place: overdue tasks and the inbox, most pressing first.
  // (Prayers are fixed times to plan around, never tasks to move.)
  const only = options.taskIds ? new Set(options.taskIds) : undefined;
  const candidates = tasks
    .filter((task) => task.kind !== "prayer")
    .filter((task) => (only ? only.has(task.id) : task.status !== "in_progress" && (!task.due_at || new Date(task.due_at).getTime() < now.getTime())))
    .sort((x, y) => x.priority - y.priority || Number(!x.due_at) - Number(!y.due_at) || (x.due_at ?? x.created_at).localeCompare(y.due_at ?? y.created_at))
    .slice(0, options.all ? 30 : options.scope === "week" ? 14 : 8);
  if (candidates.length === 0) return { nothing: "Nothing is waiting for a slot: there are no overdue tasks and the inbox is empty." };
  // Busy: every other open timed task for its length, prayers ±15 minutes.
  const candidateIds = new Set(candidates.map((task) => task.id));
  const busyTime = busyIntervals(tasks.filter((task) => !candidateIds.has(task.id) && task.status !== "draft"));
  if (placeAll([{ id: -1, title: "", minutes: 30, priority: 4, deep: true }], busyTime, windows, earliest).left.length > 0) {
    return { nothing: `There is no free hour left ${options.scope === "week" ? "this week" : localDate(first) === localDate(now) ? "today" : "that day"}.`, full: true };
  }

  let proposed: Awaited<ReturnType<typeof modelProposal>>;
  let plannedBy: Plan["planned_by"] = "model";
  try {
    proposed = await modelProposal({ now, days, windows, fixed, candidates, memory, instructions: options.instructions, all: options.all });
  } catch (error) {
    console.error("Planner: the model was unavailable, using rules instead:", error);
    proposed = rulesProposal(candidates, memory, days);
    plannedBy = "rules";
  }

  // The model proposes; this places. A proposed time is kept only if it is really free;
  // otherwise each task goes to the first free time that suits it (deep work in the
  // morning, light tasks later), clear of other tasks, prayers and quiet hours.
  const items: PlanItem[] = [];
  const leftOut: PlanLeftOut[] = [];
  const byId = new Map(candidates.map((task) => [task.id, task]));
  const reasons = new Map(proposed.proposals.map((proposal) => [proposal.id, proposal]));
  const toPlace: ToPlace[] = [];
  for (const task of candidates) {
    const proposal = reasons.get(task.id);
    const declined = proposed.leftOut.get(task.id);
    // He asked for all of them: a task the model left out still goes wherever there is free time.
    if (declined !== undefined && !proposal?.at && !options.all) {
      leftOut.push({ task_id: task.id, title: task.title, why: declined || "it did not fit" });
      continue;
    }
    const minutes = task.duration_minutes || estimateMinutes(task.title);
    // His routine: where this kind of task belongs (his usual time, its own hours), and his teaching hours kept clear.
    const kind = kindOf(task.title, task.project_id ? projectName.get(task.project_id) : undefined);
    toPlace.push({
      id: task.id,
      title: task.title,
      minutes,
      priority: task.priority,
      deep: isDeep(task.title, minutes, task.priority),
      prefer: proposal?.at,
      within: days.flatMap((day) => preferredRanges(routine, kind, day)),
      avoid: days.flatMap((day) => blockedRanges(routine, kind, day)),
      ...(options.daysFor?.[task.id] ? { windows: windows.filter((_, index) => localDate(days[index]) === options.daysFor![task.id]) } : {}),
    });
  }
  const placement = placeAll(toPlace, busyTime, windows, earliest);
  for (const { id, at } of placement.placed) {
    const task = byId.get(id)!;
    const proposal = reasons.get(id);
    const kept = proposal?.at && Math.abs(at.getTime() - proposal.at.getTime()) < STEP_MINUTES * MINUTE;
    items.push({ task_id: id, title: task.title, at: at.toISOString(), why: kept && proposal?.why ? proposal.why : isDeep(task.title, task.duration_minutes || 30, task.priority) ? "a clear stretch for focused work" : "a free slot later in the day" });
  }
  for (const id of placement.left) {
    const task = byId.get(id)!;
    leftOut.push({ task_id: id, title: task.title, why: options.scope === "week" ? "no free time left this week" : "no free time left that day" });
  }
  items.sort((x, y) => x.at.localeCompare(y.at));

  const { data, error } = await db
    .from("plans")
    .insert({ scope: options.scope, day: localDate(first), items, left_out: leftOut, why: proposed.why, planned_by: plannedBy, lead: lead ?? null, compact: Boolean(only) })
    .select()
    .single();
  if (error) throw new Error(`buildPlan: ${error.message}`);
  return { plan: data as Plan };
}

export async function loadPlan(id: number): Promise<Plan | undefined> {
  const { data, error } = await requireDb().from("plans").select().eq("id", id).maybeSingle();
  if (error) throw new Error(`loadPlan: ${error.message}`);
  return (data as Plan | null) ?? undefined;
}

async function savePlan(id: number, patch: Partial<Plan>): Promise<void> {
  const { error } = await requireDb().from("plans").update(patch).eq("id", id);
  if (error) throw new Error(`savePlan: ${error.message}`);
}

export const notePlanMessage = (id: number, messageId: number) => savePlan(id, { message_id: messageId });

/** The plan as a Telegram message, with [Apply] [Adjust], or per-task controls when adjusting. */
export async function planView(plan: Plan, now = new Date(), mode: "view" | "adjust" = "view"): Promise<{ html: string; keyboard?: InlineKeyboard }> {
  const first = parseLocalDateTime(`${plan.day.slice(0, 10)}T12:00`)!;
  const name = plan.scope === "week" ? "The week" : plan.day === localDate(now) ? "Today" : plan.day === localDate(addMinutes(now, 24 * 60)) ? "Tomorrow" : weekdayOf(first);
  const parts = [`<b>🧭 Plan · ${esc(name)} · ${esc(shortDay(first))}</b>`];
  if (plan.lead) parts.push(esc(plan.lead));

  // Tasks he just gave without times: one line, "Presentation 13:00 · Zoom tutorial 18:00".
  if (plan.compact && plan.status === "proposed" && mode === "view" && plan.items.length > 0) {
    // All of them at once, as a table; nothing is kept until "Looks good".
    const lengths = await requireDb().from("tasks").select("id, duration_minutes").in("id", plan.items.map((item) => item.task_id));
    const minutes = new Map(((lengths.data ?? []) as { id: number; duration_minutes: number | null }[]).map((row) => [row.id, row.duration_minutes]));
    // Over several days, each row says its day: five workouts, Monday to Friday, read as one day
    // without it (22 Nov: "He add them to the one single day?").
    const itemDays = [...new Set(plan.items.map((item) => localDate(new Date(item.at))))].sort();
    const spread = itemDays.length > 1;
    const rows = plan.items
      .map((item) => {
        const length = minutes.get(item.task_id);
        const at = new Date(item.at);
        return `<tr>${spread ? `<td>${esc(shortDay(at))}</td>` : ""}<td>${formatTime(at)}</td><td>${esc(item.title)}</td><td>${length ? `${length} min` : ""}</td></tr>`;
      })
      .join("");
    const left = plan.left_out.length ? `\n\nNo room for ${plan.left_out.map((item) => esc(item.title)).join(", ")} ${spread ? "this week" : "that day"}.` : "";
    const span = spread ? `${shortDay(parseLocalDateTime(`${itemDays[0]}T12:00`)!)} – ${shortDay(parseLocalDateTime(`${itemDays[itemDays.length - 1]}T12:00`)!)}` : shortDay(itemDays.length ? parseLocalDateTime(`${itemDays[0]}T12:00`)! : first);
    // Nothing is set until he taps ✓, and the words say so: "Here's what I'll do, sir:" read as done (22 Nov
    // 12:36, five workouts; 18:53, "Add them anyway for tomorrow"): neither was ever confirmed, so neither was set.
    const lead = plan.lead && plan.lead !== "Here's what I'll do, sir:" ? `${esc(plan.lead)}\n\n` : "";
    const confirm = `\n\n${i(`Nothing is set yet: tap ✓ Looks good and I'll put ${plan.items.length === 1 ? "it" : "them"} in, sir.`)}`;
    const html = `${lead}<b>🧭 ${esc(spread ? "The week" : name)} · ${esc(span)}</b>\n<table><tr>${spread ? "<th>Day</th>" : ""}<th>Time</th><th>Task</th><th>Length</th></tr>${rows}</table>${left}${confirm}`;
    const keyboard = new InlineKeyboard().text("✓ Looks good", `pl:ap:${plan.id}`).text("✏️ Change", `pl:adj:${plan.id}`);
    return { html, keyboard };
  }

  // What is already fixed on those days is shown too, so the plan reads as the whole day.
  const lastDay = addMinutes(first, (plan.scope === "week" ? 6 : 0) * 24 * 60);
  const fixedRows = await requireDb()
    .from("tasks")
    .select()
    .in("status", OPEN_STATUSES)
    .gte("due_at", dayBounds(first).start.toISOString())
    .lt("due_at", dayBounds(lastDay).end.toISOString());
  if (fixedRows.error) throw new Error(`planView: ${fixedRows.error.message}`);
  const planned = new Set(plan.items.map((item) => Number(item.task_id)));
  const fixed = (fixedRows.data as Task[]).filter((task) => !planned.has(task.id) && new Date(task.due_at!).getTime() >= now.getTime());

  type Line = { at: Date; html: string };
  const lines: Line[] = [
    ...fixed.map((task) => ({ at: new Date(task.due_at!), html: `${code(clockOf(task))} ${esc(task.title)}${task.persistent ? " 🔔" : ""}` })),
    ...plan.items.map((item) => ({ at: new Date(item.at), html: `${code(formatTime(new Date(item.at)))} ➕ ${b(item.title)}${item.why ? `\n      ${i(item.why)}` : ""}` })),
  ].sort((x, y) => x.at.getTime() - y.at.getTime());

  if (plan.items.length === 0) parts.push("Nothing found a slot, sir.");
  if (plan.scope === "week") {
    const days = [...new Set(lines.map((line) => localDate(line.at)))];
    for (const day of days) {
      parts.push([b(shortDay(parseLocalDateTime(`${day}T12:00`)!)), ...lines.filter((line) => localDate(line.at) === day).map((line) => line.html)].join("\n"));
    }
  } else if (lines.length > 0) {
    parts.push(lines.map((line) => line.html).join("\n"));
  }
  if (plan.left_out.length > 0) {
    parts.push([b("Left for later"), ...plan.left_out.map((item) => `• ${esc(item.title)} ${i(item.why)}`)].join("\n"));
  }
  if (plan.why) parts.push(expandable(`💡 ${b("Why")} ${esc(plan.why)}${plan.planned_by === "rules" ? ` ${i("(planned by rule; my thinking was unavailable)")}` : ""}`));
  // Two fixed things at once on the planned day(s): flagged, as in the morning brief.
  for (const [a, c] of allClashes(fixedRows.data as Task[])) parts.push(`⚠️ ${esc(clashSentence(a, c))}`);
  if (plan.status === "applied") parts.push("✓ Applied, sir. Reminders are set.");
  if (plan.status === "dismissed") parts.push("Set aside, sir.");
  const html = parts.join("\n\n");
  // Overdue tasks the plan could not place: tomorrow, or drop, one by one or all at once. Plain code.
  const overdueLeft = plan.status === "proposed" && mode === "view" ? await overdueAmong(plan.left_out.map((item) => item.task_id), now) : [];
  if (plan.status !== "proposed" || plan.items.length === 0) {
    if (overdueLeft.length === 0) return { html };
    return { html, keyboard: leftOutKeyboard(plan.id, overdueLeft) };
  }

  const keyboard = new InlineKeyboard();
  if (mode === "view") {
    keyboard.text("✓ Apply", `pl:ap:${plan.id}`).text("✎ Adjust", `pl:adj:${plan.id}`);
    if (overdueLeft.length > 0) {
      keyboard.row();
      for (const row of leftOutKeyboard(plan.id, overdueLeft).inline_keyboard) {
        for (const button of row) if ("callback_data" in button && button.callback_data) keyboard.text(button.text, button.callback_data);
        keyboard.row();
      }
    }
  } else {
    plan.items.forEach((item, index) => {
      const title = item.title.length > 16 ? `${item.title.slice(0, 15)}…` : item.title;
      keyboard
        .text("−1h", `pl:m:${plan.id}:${index}:-60`)
        .text(`${formatTime(new Date(item.at))} ${title}`, `pl:noop:${plan.id}`)
        .text("+1h", `pl:m:${plan.id}:${index}:60`)
        .text("✕", `pl:x:${plan.id}:${index}`)
        .row();
    });
    keyboard.text("✓ Apply", `pl:ap:${plan.id}`).text("↺ Plan again", `pl:re:${plan.id}`).text("Drop plan", `pl:no:${plan.id}`);
  }
  return { html, keyboard };
}

/** Which of these tasks are open and overdue (to offer Tomorrow / Drop for them). */
async function overdueAmong(ids: number[], now: Date): Promise<Task[]> {
  if (ids.length === 0) return [];
  const { data } = await requireDb().from("tasks").select().in("id", ids).in("status", OPEN_STATUSES).lt("due_at", now.toISOString());
  return (data ?? []) as Task[];
}

/** [→ Tomorrow] [Drop] for each overdue task left out, and [Move all to tomorrow]. */
function leftOutKeyboard(planId: number, tasks: Task[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const task of tasks.slice(0, 6)) {
    const title = task.title.length > 18 ? `${task.title.slice(0, 17)}…` : task.title;
    keyboard.text(`${title} → Tomorrow`, `tomorrow:${task.id}`).text("Drop", `drop:${task.id}`).row();
  }
  if (tasks.length > 1) keyboard.text("Move all to tomorrow", `pl:tomall:${planId}`);
  return keyboard;
}

/** Moves one item of a proposed plan by `minutes`, to the nearest free start in that direction. */
export async function shiftPlanItem(planId: number, index: number, minutes: number, now = new Date()): Promise<{ plan?: Plan; note: string }> {
  const plan = await loadPlan(planId);
  if (!plan || plan.status !== "proposed" || !plan.items[index]) return { note: "That plan is no longer open, sir." };
  const settings = await getSettings();
  const item = plan.items[index];
  const window = windowOf(new Date(item.at), settings.quiet_start);
  const others: Busy[] = plan.items.filter((_, n) => n !== index).map((other) => ({ at: new Date(other.at), title: other.title }));
  const fixedRows = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).gte("due_at", window.start.toISOString()).lte("due_at", addMinutes(window.end, 60).toISOString());
  if (fixedRows.error) throw new Error(`shiftPlanItem: ${fixedRows.error.message}`);
  const planned = new Set(plan.items.map((entry) => Number(entry.task_id)));
  const busy = [...others, ...(fixedRows.data as Task[]).filter((task) => !planned.has(task.id)).map((task) => ({ at: new Date(task.due_at!), title: task.title }))];

  const direction = Math.sign(minutes) * STEP_MINUTES;
  let at = addMinutes(new Date(item.at), minutes);
  for (let guard = 0; guard < 96 && clashes(at, busy); guard++) at = addMinutes(at, direction);
  if (at.getTime() < Math.max(window.start.getTime(), now.getTime()) || at.getTime() > window.end.getTime() || clashes(at, busy)) {
    return { plan, note: minutes < 0 ? "Nothing free earlier, sir." : "Nothing free later that day, sir." };
  }
  const items = plan.items.map((entry, n) => (n === index ? { ...entry, at: at.toISOString(), why: "moved by you" } : entry)).sort((x, y) => x.at.localeCompare(y.at));
  await savePlan(plan.id, { items });
  return { plan: { ...plan, items }, note: `${item.title}: ${formatTime(at)}` };
}

export async function removePlanItem(planId: number, index: number): Promise<Plan | undefined> {
  const plan = await loadPlan(planId);
  if (!plan || plan.status !== "proposed" || !plan.items[index]) return plan;
  const removed = plan.items[index];
  const items = plan.items.filter((_, n) => n !== index);
  const left_out = [...plan.left_out, { task_id: removed.task_id, title: removed.title, why: "taken out by you" }];
  await savePlan(plan.id, { items, left_out });
  return { ...plan, items, left_out };
}

export async function dismissPlan(planId: number): Promise<Plan | undefined> {
  const plan = await loadPlan(planId);
  if (!plan || plan.status !== "proposed") return plan;
  await savePlan(plan.id, { status: "dismissed" });
  // Proposed tasks he did not confirm are not kept.
  const ids = plan.items.map((item) => item.task_id);
  if (ids.length) await requireDb().from("tasks").delete().in("id", ids).eq("status", "draft");
  return { ...plan, status: "dismissed" };
}

/** Makes a proposed plan real: each task gets its time and its reminder. */
export async function applyPlan(planId: number, now = new Date()): Promise<{ plan?: Plan; applied: number }> {
  const db = requireDb();
  const plan = await loadPlan(planId);
  if (!plan) return { applied: 0 };
  if (plan.status !== "proposed") return { plan, applied: 0 };
  let applied = 0;
  for (const item of plan.items) {
    const at = new Date(item.at);
    // A plan applied late: anything whose time has passed is skipped, not booked into the past.
    if (at.getTime() <= now.getTime()) continue;
    const found = await db.from("tasks").select().eq("id", item.task_id).maybeSingle();
    const task = found.data as Task | null;
    // Open tasks, and drafts he has just confirmed with "Looks good".
    if (!task || !(OPEN_STATUSES.includes(task.status) || task.status === "draft")) continue;
    const { error } = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo" }).eq("id", task.id);
    if (error) throw new Error(`applyPlan: ${error.message}`);
    await scheduleReminder(task.id, at);
    applied++;
  }
  await savePlan(plan.id, { status: "applied", applied_at: now.toISOString() });
  return { plan: { ...plan, status: "applied", applied_at: now.toISOString() }, applied };
}

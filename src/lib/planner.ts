import "server-only";
import { InlineKeyboard } from "grammy";
import { chat, type ToolDefinition } from "./brain/model";
import { requireDb } from "./db";
import { b, code, esc, expandable, i } from "./html";
import { scheduleReminder } from "./reminders";
import { getSettings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, localDate, parseClock, parseLocalDateTime, TIMEZONE } from "./time";

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
function windowOf(day: Date, quietStart: string): Window {
  const { start } = dayBounds(day);
  const quiet = parseClock(quietStart);
  const endMinute = quiet > 12 * 60 ? quiet - 60 : 22 * 60;
  return { start: addMinutes(start, DAY_STARTS), end: addMinutes(start, endMinute) };
}

const clashes = (at: Date, busy: Busy[]) => busy.some((other) => Math.abs(other.at.getTime() - at.getTime()) < BLOCK_MINUTES * MINUTE);

/** The first free start time at or after `from`, within the given days' windows. */
function nextFree(from: Date, busy: Busy[], windows: Window[], earliest: Date): Date | undefined {
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
}): Promise<{ proposals: Proposal[]; leftOut: Map<number, string>; why: string }> {
  const { now, days, windows, fixed, candidates, memory, instructions } = input;
  const describe = (task: Task) => {
    const state = task.due_at ? `overdue since ${shortDay(new Date(task.due_at))} ${formatTime(new Date(task.due_at))}` : `in the inbox ${Math.floor((now.getTime() - new Date(task.created_at).getTime()) / (24 * 60 * MINUTE))} days`;
    return `#${task.id} ${task.title} | ${state} | P${task.priority}${task.persistent ? " | important" : ""}`;
  };
  const system = [
    "You schedule tasks for Behruzbek, an English teacher and content creator in Tashkent. Choose a day and start time for each task.",
    `Rules: only between ${formatTime(windows[0].start)} and ${formatTime(windows[0].end)}; nothing before the current time; never within an hour of a fixed event or of another task; at most ${MAX_PER_DAY} new tasks a day.`,
    "Follow his habits where one applies, and put urgent (P1, P2) and overdue tasks first. If a task does not fit, leave it out and say why.",
    "Each reason is short, plain, and addressed to him: 'you work out in the evenings', 'free hour after classes'.",
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

export type PlanResult = { plan: Plan } | { nothing: string };

/**
 * Proposes a plan for a day (default: today) or the week from that day.
 * Stored as 'proposed'; applyPlan makes it real.
 */
export async function buildPlan(options: { scope: "day" | "week"; day?: Date; instructions?: string; now?: Date }): Promise<PlanResult> {
  const db = requireDb();
  const now = options.now ?? new Date();
  const first = options.day ?? now;
  const settings = await getSettings();
  const days = Array.from({ length: options.scope === "week" ? 7 : 1 }, (_, n) => addMinutes(first, n * 24 * 60));
  const windows = days.map((day) => windowOf(day, settings.quiet_start));
  const earliest = snap(addMinutes(now, 15));

  const [taskRows, memoryRows] = await Promise.all([
    db.from("tasks").select().in("status", OPEN_STATUSES).limit(500),
    db.from("memory").select("fact").order("id"),
  ]);
  if (taskRows.error || memoryRows.error) throw new Error(`buildPlan: ${(taskRows.error ?? memoryRows.error)!.message}`);
  const tasks = taskRows.data as Task[];
  const memory = (memoryRows.data as { fact: string }[]).map((row) => row.fact);

  // Fixed: anything that already has a time still ahead in the days being planned.
  const horizonEnd = dayBounds(days[days.length - 1]).end.getTime();
  const fixed: Busy[] = tasks
    .filter((task) => task.due_at && new Date(task.due_at).getTime() >= now.getTime() && new Date(task.due_at).getTime() < horizonEnd)
    .map((task) => ({ at: new Date(task.due_at!), title: task.title }));

  // To place: overdue tasks and the inbox, most pressing first.
  const candidates = tasks
    .filter((task) => task.status !== "in_progress" && (!task.due_at || new Date(task.due_at).getTime() < now.getTime()))
    .sort((x, y) => x.priority - y.priority || Number(!x.due_at) - Number(!y.due_at) || (x.due_at ?? x.created_at).localeCompare(y.due_at ?? y.created_at))
    .slice(0, options.scope === "week" ? 14 : 8);
  if (candidates.length === 0) return { nothing: "Nothing is waiting for a slot: there are no overdue tasks and the inbox is empty." };
  if (nextFree(earliest, fixed, windows, earliest) === undefined) {
    return { nothing: `There is no free hour left ${options.scope === "week" ? "this week" : localDate(first) === localDate(now) ? "today" : "that day"}.` };
  }

  let proposed: Awaited<ReturnType<typeof modelProposal>>;
  let plannedBy: Plan["planned_by"] = "model";
  try {
    proposed = await modelProposal({ now, days, windows, fixed, candidates, memory, instructions: options.instructions });
  } catch (error) {
    console.error("Planner: the model was unavailable, using rules instead:", error);
    proposed = rulesProposal(candidates, memory, days);
    plannedBy = "rules";
  }

  // The model proposes; this places. Each time is checked and, if it clashes
  // or falls outside the day, moved to the next free slot.
  const busy = [...fixed];
  const items: PlanItem[] = [];
  const leftOut: PlanLeftOut[] = [];
  const perDay = new Map<string, number>();
  const byId = new Map(candidates.map((task) => [task.id, task]));
  const order = [...proposed.proposals.filter((p) => byId.has(p.id)), ...candidates.filter((task) => !proposed.proposals.some((p) => p.id === task.id)).map((task): Proposal => ({ id: task.id, why: "" }))];
  const seen = new Set<number>();
  for (const proposal of order) {
    if (seen.has(proposal.id)) continue;
    seen.add(proposal.id);
    const task = byId.get(proposal.id)!;
    const declined = proposed.leftOut.get(task.id);
    if (declined !== undefined && !proposal.at) {
      leftOut.push({ task_id: task.id, title: task.title, why: declined || "it did not fit" });
      continue;
    }
    let from = proposal.at ?? earliest;
    let at: Date | undefined;
    // Skip days that are already full.
    for (let guard = 0; guard < 8; guard++) {
      at = nextFree(from, busy, windows, earliest);
      if (!at || (perDay.get(localDate(at)) ?? 0) < MAX_PER_DAY) break;
      from = dayBounds(addMinutes(at, 24 * 60)).start;
      at = undefined;
    }
    if (!at) {
      leftOut.push({ task_id: task.id, title: task.title, why: options.scope === "week" ? "no free hour left this week" : "no free hour left in the day" });
      continue;
    }
    const moved = proposal.at && Math.abs(at.getTime() - proposal.at.getTime()) >= STEP_MINUTES * MINUTE;
    busy.push({ at, title: task.title });
    perDay.set(localDate(at), (perDay.get(localDate(at)) ?? 0) + 1);
    items.push({
      task_id: task.id,
      title: task.title,
      at: at.toISOString(),
      why: moved || !proposal.why ? (proposal.why && !moved ? proposal.why : "the nearest free hour") : proposal.why,
    });
  }
  items.sort((x, y) => x.at.localeCompare(y.at));

  const { data, error } = await db
    .from("plans")
    .insert({ scope: options.scope, day: localDate(first), items, left_out: leftOut, why: proposed.why, planned_by: plannedBy })
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
    ...fixed.map((task) => ({ at: new Date(task.due_at!), html: `${code(formatTime(new Date(task.due_at!)))} ${esc(task.title)}${task.persistent ? " 🔔" : ""}` })),
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
  if (plan.status === "applied") parts.push("✓ Applied, sir. Reminders are set.");
  if (plan.status === "dismissed") parts.push("Set aside, sir.");
  const html = parts.join("\n\n");
  if (plan.status !== "proposed" || plan.items.length === 0) return { html };

  const keyboard = new InlineKeyboard();
  if (mode === "view") {
    keyboard.text("✓ Apply", `pl:ap:${plan.id}`).text("✎ Adjust", `pl:adj:${plan.id}`);
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
    if (!task || !OPEN_STATUSES.includes(task.status)) continue;
    const { error } = await db.from("tasks").update({ due_at: at.toISOString(), status: "todo" }).eq("id", task.id);
    if (error) throw new Error(`applyPlan: ${error.message}`);
    await scheduleReminder(task.id, at);
    applied++;
  }
  await savePlan(plan.id, { status: "applied", applied_at: now.toISOString() });
  return { plan: { ...plan, status: "applied", applied_at: now.toISOString() }, applied };
}

/**
 * One concrete slot for one task, for an unprompted suggestion: where a
 * habit points if he has told Tony one, otherwise the next free hour today.
 * Rule-based, so a suggestion costs no model call.
 */
export async function suggestSlot(task: Task, now = new Date()): Promise<{ at: Date; reason: string } | undefined> {
  const db = requireDb();
  const settings = await getSettings();
  const window = windowOf(now, settings.quiet_start);
  const earliest = snap(addMinutes(now, 30));
  const [fixedRows, memoryRows] = await Promise.all([
    db.from("tasks").select().in("status", OPEN_STATUSES).gte("due_at", dayBounds(now).start.toISOString()).lt("due_at", dayBounds(now).end.toISOString()),
    db.from("memory").select("fact").order("id"),
  ]);
  if (fixedRows.error || memoryRows.error) throw new Error(`suggestSlot: ${(fixedRows.error ?? memoryRows.error)!.message}`);
  const today = (fixedRows.data as Task[]).filter((other) => other.id !== task.id);
  const busy: Busy[] = today.filter((other) => new Date(other.due_at!).getTime() >= now.getTime() - BLOCK_MINUTES * MINUTE).map((other) => ({ at: new Date(other.due_at!), title: other.title }));

  const habit = habitFor(task.title, (memoryRows.data as { fact: string }[]).map((row) => row.fact));
  const wanted = habit ? addMinutes(dayBounds(now).start, habit.minute) : undefined;
  if (habit && wanted && wanted.getTime() >= earliest.getTime()) {
    const at = nextFree(wanted, busy, [window], earliest);
    if (at && at.getTime() - wanted.getTime() <= 90 * MINUTE) return { at, reason: `you told me "${habit.fact}"` };
  }
  const at = nextFree(earliest, busy, [window], earliest);
  if (!at) return undefined;
  // "You're free after the club": name what comes just before the slot, if anything today does.
  const before = today.filter((other) => new Date(other.due_at!).getTime() < at.getTime()).sort((x, y) => y.due_at!.localeCompare(x.due_at!))[0];
  return { at, reason: before && at.getTime() - new Date(before.due_at!).getTime() <= 3 * 60 * MINUTE ? `you are free after ${before.title}` : `you have a free hour at ${formatTime(at)}` };
}

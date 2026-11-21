import "server-only";
import { requireDb } from "./db";
import { getSettings } from "./settings";
import { logEvent } from "./events";
import { nearestFreeFor } from "./routine";
import { budgetLeft, notify } from "./safety";
import { openButton } from "./link-rules";
import { missedToday, openLine, slippedDays, staleInbox, stillOpen, type OpenTask } from "./smart-rules";
import { OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, hisDate, parseLocalDateTime, TIMEZONE } from "./time";

/**
 * The follow-up ladder (phase d, 21 Nov): no task may silently disappear.
 * - Missed today: one message later the same day, every missed task in it,
 *   each with [✓] [⏰ later today] [📅 tomorrow] [🗑].
 * - Next morning and every morning after: "⚠️ Still open" at the top of the
 *   brief, with the same buttons.
 * - Slipped three days or more: firmer, with [🧩 steps] [📌 fixed slot] [🗑].
 * - Sunday evening: the inbox items untouched for a week, [📅] [📌 keep] [🗑].
 * Grouped, never one ping per task; quiet hours and the day's budget kept.
 * Buttons are "fu:<action>:<task>", handled in code (bot.ts), never the model.
 */

const HOUR = 60 * 60_000;
export type Row = { text: string; data: string }[];

async function openTasks(): Promise<OpenTask[]> {
  const { data, error } = await requireDb().from("tasks").select().in("status", OPEN_STATUSES).limit(500);
  if (error) throw new Error(`followups: ${error.message}`);
  return (data as Task[]).filter((task) => task.kind !== "prayer") as unknown as OpenTask[];
}

/** One task's buttons in a grouped message: the usual four, or the firmer three after three days. */
export function taskButtons(task: OpenTask, number: number, now: Date): Row {
  if (slippedDays(task, now) >= 3) {
    return [
      { text: `🧩 ${number}`, data: `fu:steps:${task.id}` },
      { text: `📌 ${number}`, data: `fu:slot:${task.id}` },
      { text: `🗑 ${number}`, data: `fu:drop:${task.id}` },
    ];
  }
  return [
    { text: `✓ ${number}`, data: `fu:done:${task.id}` },
    { text: `⏰ ${number}`, data: `fu:later:${task.id}` },
    { text: `📅 ${number}`, data: `fu:tom:${task.id}` },
    { text: `🗑 ${number}`, data: `fu:drop:${task.id}` },
  ];
}

/** A grouped follow-up: one line per task, one row of buttons each; a single task gets the buttons in words. */
export function followUpMessage(tasks: OpenTask[], now: Date, lead: string): { text: string; rows: Row[] } {
  if (tasks.length === 1) {
    const [task] = tasks;
    const firm = slippedDays(task, now) >= 3;
    const text = firm ? `${lead} ${openLine(task, now)}. Break it into steps, give it a fixed slot, or drop it?` : `${lead} ${openLine(task, now)}`;
    const rows: Row[] = firm
      ? [[{ text: "🧩 Steps", data: `fu:steps:${task.id}` }, { text: "📌 Fixed slot", data: `fu:slot:${task.id}` }, { text: "🗑 Drop", data: `fu:drop:${task.id}` }]]
      : [[{ text: "✓ Done", data: `fu:done:${task.id}` }, { text: "⏰ Later today", data: `fu:later:${task.id}` }], [{ text: "📅 Tomorrow", data: `fu:tom:${task.id}` }, { text: "🗑 Drop", data: `fu:drop:${task.id}` }]];
    // A task with a link (a reel to watch): the link itself, one tap away (21 Nov: "send me now" got the wrong reel).
    const open = openButton(task.notes);
    if (open) rows.unshift([{ text: open.text, data: `url:${open.url}` }]);
    return { text, rows };
  }
  const shown = tasks.slice(0, 8);
  const lines = shown.map((task, index) => `${index + 1}. ${openLine(task, now)}`);
  if (shown.length >= 3) {
    // Three or more: a short grid, two tasks a row ([✓ 1] [📅 1] [✓ 2] [📅 2]), then one button for all.
    const pairs = shown.map((task, index) => [
      { text: `✓ ${index + 1}`, data: `fu:done:${task.id}` },
      { text: `📅 ${index + 1}`, data: `fu:tom:${task.id}` },
    ]);
    const rows: Row[] = [];
    for (let n = 0; n < pairs.length; n += 2) rows.push([...pairs[n], ...(pairs[n + 1] ?? [])]);
    rows.push([{ text: "📅 All to tomorrow", data: `fu:all:${shown.map((task) => task.id).join(",")}` }]);
    return { text: [lead, ...lines, "_✓ done · 📅 tomorrow_"].join("\n"), rows };
  }
  const firm = shown.some((task) => slippedDays(task, now) >= 3);
  const legend = firm ? "✓ done · ⏰ later today · 📅 tomorrow · 🗑 drop; 🧩 steps · 📌 fixed slot for the ones that slipped 3 days" : "✓ done · ⏰ later today · 📅 tomorrow · 🗑 drop";
  return { text: [lead, ...lines, `_${legend}_`].join("\n"), rows: shown.map((task, index) => taskButtons(task, index + 1, now)) };
}

/** Today's follow-up was sent for these tasks. */
async function followedUpToday(now: Date): Promise<Set<number>> {
  const { start } = dayBounds(now, TIMEZONE);
  const { data } = await requireDb().from("events").select("detail").eq("kind", "followup").gte("created_at", start.toISOString());
  return new Set(((data ?? []) as { detail: { task_ids?: number[] } }[]).flatMap((row) => row.detail?.task_ids ?? []));
}

/** Tasks with a reminder still to come (a snooze, "ask me again at 17:10"): already handled. */
async function waitingOnReminder(now: Date): Promise<number[]> {
  const { data, error } = await requireDb().from("reminders").select("task_id").eq("state", "scheduled").gt("fire_at", now.toISOString()).neq("kind", "brief").limit(500);
  if (error) throw new Error(`followups: ${error.message}`);
  return ((data ?? []) as { task_id: number | null }[]).flatMap((row) => (row.task_id === null ? [] : [row.task_id]));
}

/**
 * Missed today, followed up later the same day: every task two hours or more
 * past its time and still open goes into one message, at most once each,
 * outside quiet hours (the caller checks) and within the budget.
 */
/** At most one "still open" message every three hours: what slipped in between waits and comes together. */
export const FOLLOW_UP_GAP_MS = 3 * HOUR;

/** When today's last same-day follow-up went out (the brief's "Still open" does not count). */
async function lastFollowUpToday(now: Date): Promise<Date | undefined> {
  const { start } = dayBounds(now, TIMEZONE);
  const { data } = await requireDb().from("events").select("created_at, detail").eq("kind", "followup").gte("created_at", start.toISOString()).order("created_at", { ascending: false }).limit(10);
  const row = ((data ?? []) as { created_at: string; detail: { brief?: boolean } }[]).find((entry) => !entry.detail?.brief);
  return row ? new Date(row.created_at) : undefined;
}

export async function sameDayFollowUp(now: Date): Promise<{ text: string; rows: Row[]; taskIds: number[] } | undefined> {
  // 21 Nov: seven separate "still open" pings, one per task as each became two hours late. Now they are grouped.
  const last = await lastFollowUpToday(now);
  if (last && now.getTime() - last.getTime() < FOLLOW_UP_GAP_MS) return undefined;
  // Within two hours of the evening review, it waits for the review, which lists everything still open.
  const { brief_evening: evening } = await getSettings().catch(() => ({ brief_evening: null as string | null }));
  if (evening) {
    const [h, m] = String(evening).slice(0, 5).split(":").map(Number);
    const review = parseLocalDateTime(`${hisDate(now, TIMEZONE)}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    if (review && review.getTime() - now.getTime() < 2 * HOUR && now.getTime() < review.getTime() + 3 * HOUR) return undefined;
  }
  // A task he snoozed or that has another reminder still to come is handled: no "still open" for it.
  const skip = new Set([...(await followedUpToday(now)), ...(await waitingOnReminder(now))]);
  const tasks = missedToday(await openTasks(), now, skip);
  if (tasks.length === 0) return undefined;
  if ((await budgetLeft(now)) <= 0) return undefined;
  const lead = tasks.length === 1 ? "⏰ Still open from today:" : `⏰ ${tasks.length} still open from today:`;
  return { ...followUpMessage(tasks, now, lead), taskIds: tasks.map((task) => task.id) };
}

/** Noted as followed up (and as one of the day's unasked messages). */
export async function noteFollowUp(taskIds: number[], now: Date): Promise<void> {
  await logEvent("followup", { task_ids: taskIds });
  await notify("followup", now);
}

/** The top of the morning brief: what is still open from earlier days, with its buttons. */
export async function stillOpenSection(now: Date): Promise<{ text: string; rows: Row[]; taskIds: number[] } | undefined> {
  const tasks = stillOpen(await openTasks(), now);
  if (tasks.length === 0) return undefined;
  return { ...followUpMessage(tasks, now, tasks.length === 1 ? "⚠️ Still open:" : `⚠️ Still open · ${tasks.length}`), taskIds: tasks.map((task) => task.id) };
}

/** Sunday evening: inbox items untouched for a week, to schedule, keep or drop. */
export async function weeklyInboxReview(now: Date): Promise<{ text: string; rows: Row[] } | undefined> {
  const tasks = staleInbox(await openTasks(), now).slice(0, 8);
  if (tasks.length === 0) return undefined;
  const lines = tasks.map((task, index) => {
    const days = Math.floor((now.getTime() - new Date(task.updated_at).getTime()) / (24 * HOUR));
    return `${index + 1}. **${task.title}** · untouched ${days} days`;
  });
  const rows = tasks.map((task, index) => [
    { text: `📅 ${index + 1}`, data: `fu:sched:${task.id}` },
    { text: `📌 ${index + 1}`, data: `fu:keep:${task.id}` },
    { text: `🗑 ${index + 1}`, data: `fu:drop:${task.id}` },
  ]);
  return { text: ["🗂 **Sunday inbox review**: these have waited a week or more.", ...lines, "_📅 schedule · 📌 keep · 🗑 drop_"].join("\n"), rows };
}

/** "Later today": the nearest free time at least two hours from now, today; else two hours from now. */
export async function laterToday(task: Task, now: Date): Promise<Date> {
  const target = addMinutes(now, 120);
  const free = await nearestFreeFor(task, target, now).catch(() => undefined);
  const { end } = dayBounds(now, TIMEZONE);
  const pick = free && free.getTime() >= now.getTime() + HOUR && free.getTime() < end.getTime() ? free : target;
  return new Date(Math.ceil(pick.getTime() / (15 * 60_000)) * 15 * 60_000);
}

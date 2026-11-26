import "server-only";
import { clearBig3, setBig3 } from "./big3";
import { BIG3 } from "./big3-rules";
import { requireDb } from "./db";
import { choicesFor } from "./routine";
import { getSettings, setPendingSlot, updateSettings } from "./settings";
import { placeAnytime, placeTask } from "./slots";
import { OPEN_STATUSES, type Task } from "./tasks";
import { formatTime, localDate, parseLocalDateTime } from "./time";
import { weekGoals } from "./week-goals";
import { MAX_WEEK_GOALS, planningWeek, shiftDay, weekStart } from "./week-rules";
import { daysLeft, queue, type WeekSession } from "./week-session-rules";

/**
 * The guided weekly planning in Telegram (Phase R, 26 Nov: "I just press this command and he starts helping
 * me organize my week … he asks everything one by one, not sending all of them at once … three maximum
 * urgent tasks"). One message, redrawn at each step: first the week's outcomes, then each waiting task
 * alone with its days. Every step is a button and runs in plain code; nothing is placed that he did not tap.
 */
export type Row = { text: string; data: string }[];
export type View = { text: string; rows: Row[] };

const TZ = "Asia/Tashkent";
const noon = (day: string) => new Date(`${day}T12:00:00+05:00`);
const fmt = (day: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...options }).format(noon(day));
const short = (day: string) => fmt(day, { weekday: "short", day: "numeric" });
const long = (day: string) => fmt(day, { weekday: "long", day: "numeric", month: "short" });
const weekSpan = (week: string) => `${fmt(week, { day: "numeric", month: "short" })} – ${fmt(shiftDay(week, 6), { day: "numeric", month: "short" })}`;

async function session(): Promise<WeekSession | undefined> {
  return (await getSettings()).week_session ?? undefined;
}
const save = (state: WeekSession | null) => updateSettings({ week_session: state });

async function waiting(state: WeekSession): Promise<{ tasks: Task[]; areas: Map<number, string> }> {
  const db = requireDb();
  const [open, projects] = await Promise.all([db.from("tasks").select().eq("status", "inbox").order("id").limit(500), db.from("projects").select("id, name").order("sort_order").order("id")]);
  const areas = ((projects.data ?? []) as { id: number; name: string }[]).filter((area) => area.name !== "Prayer");
  return { tasks: queue((open.data ?? []) as Task[], state.kept, areas.map((area) => area.id)), areas: new Map(areas.map((area) => [area.id, area.name])) };
}

/** How many of a day's three are taken by open tasks. */
async function topCount(day: string): Promise<number> {
  const { count } = await requireDb().from("tasks").select("id", { count: "exact", head: true }).eq("big3_on", day).in("status", OPEN_STATUSES);
  return count ?? 0;
}

/** /week, or [🗓 Plan week] on the board: the session begins with the week's outcomes. */
export async function openWeekSession(now = new Date()): Promise<View> {
  const today = localDate(now);
  const state: WeekSession = { week: planningWeek(today), kept: [], placed: 0, someday: 0, dropped: 0 };
  await save(state);
  const goals = (await weekGoals(now)).filter((goal) => goal.week_start === state.week);
  const { tasks } = await waiting(state);
  await updateSettings({
    pending_note: `He is planning his week (the week of ${state.week}) step by step. If his next message names an outcome or goal for that week, add it with week_goal (week "${state.week === weekStart(today) ? "this" : "next"}"), one call per outcome, and answer in one short line. Do not list or schedule his tasks: the planning message's buttons do that.`,
    pending_note_at: now.toISOString(),
  });
  const outcomes = goals.length ? goals.map((goal) => `${goal.done ? "☑" : "☐"} ${goal.title}`).join("\n") : "_None yet._";
  return {
    text: [
      `🗓 **Weekly planning** · ${weekSpan(state.week)}`,
      "",
      `**Step 1: outcomes** (${goals.length} of ${MAX_WEEK_GOALS})`,
      outcomes,
      "",
      goals.length < MAX_WEEK_GOALS ? "Send me an outcome in your own words to add it, sir: three to five make a week." : "Five is the limit, sir.",
      "",
      tasks.length ? `Then your **${tasks.length}** waiting ${tasks.length === 1 ? "task" : "tasks"}, one at a time.` : "Nothing is waiting in the inbox.",
    ].join("\n"),
    rows: [...(tasks.length ? [[{ text: "▶️ Start with the tasks", data: "wk:next" }]] : []), [{ text: "⏹ Stop", data: "wk:stop" }]],
  };
}

/** The next waiting task, alone, with the days it can go on; or the summary when none is left. */
export async function nextTask(now = new Date(), lead?: string, /** The task just given a time: [↩ Back to inbox] is offered for it. */ undoId?: number): Promise<View> {
  const state = await session();
  if (!state) return { text: "That planning session has ended, sir. Send /week to start one.", rows: [] };
  // The task before is settled: a time typed from here on is not for it.
  await setPendingSlot(null).catch(() => undefined);
  const { tasks, areas } = await waiting(state);
  const task = tasks[0];
  if (!task) return summary(now, lead);
  const view = dayStep(task, state, now, { lead, left: tasks.length, area: task.project_id ? areas.get(task.project_id) : undefined });
  // A slip of the thumb on the task before: one tap puts it back in the inbox.
  if (undoId !== undefined && undoId !== task.id) view.rows.splice(view.rows.length - 1, 0, [{ text: "↩ Undo the last one", data: `wk:back:${undoId}` }]);
  return view;
}

/** One task, alone, with the days it can go on. Also where [📅 Other day] returns to, for a task already placed. */
function dayStep(task: Task, state: WeekSession, now: Date, options: { lead?: string; left?: number; area?: string; again?: boolean } = {}): View {
  const today = localDate(now);
  const days = daysLeft(state.week, today);
  const dayRows: Row[] = [];
  for (let index = 0; index < days.length; index += 4) dayRows.push(days.slice(index, index + 4).map((day) => ({ text: day === today ? `Today ${Number(day.slice(8))}` : short(day), data: `wk:day:${task.id}:${day}` })));
  return {
    text: [
      ...(options.lead ? [options.lead, ""] : []),
      `🗓 **Planning the week**${options.left ? ` · ${options.left} left` : ""}`,
      "",
      `**${task.title}**`,
      `${options.area ?? "No area"}${task.duration_minutes ? ` · ${task.duration_minutes} min` : ""}`,
      "",
      options.again ? "Which day instead, sir?" : "Which day, sir?",
    ].join("\n"),
    rows: [
      ...dayRows,
      options.again
        ? [
            { text: "↩ Back to inbox", data: `wk:back:${task.id}` },
            { text: "Next task →", data: "wk:next" },
          ]
        : [
            { text: "📥 Keep in inbox", data: `wk:keep:${task.id}` },
            { text: "🌙 Someday", data: `wk:some:${task.id}` },
            { text: "🗑 Drop", data: `wk:drop:${task.id}` },
          ],
      [{ text: "⏹ Stop", data: "wk:stop" }],
    ],
  };
}

/**
 * [↩ Back to inbox] (26 Nov: "I suddenly pressed one task … and there is no such thing as bring it back to
 * inbox"): the task he just placed loses its day, time, reminder and star, and is asked about again.
 */
export async function backToInbox(taskId: number, now = new Date()): Promise<View> {
  const state = await session();
  if (!state) return nextTask(now);
  const db = requireDb();
  const found = await db.from("tasks").select("id, title, status").eq("id", taskId).maybeSingle();
  const task = found.data as Pick<Task, "id" | "title" | "status"> | null;
  if (!task || !OPEN_STATUSES.includes(task.status)) return nextTask(now, "That task is no longer open, sir.");
  await db.from("tasks").update({ due_at: null, status: "inbox", anytime: false, big3_on: null }).eq("id", taskId);
  await db.from("reminders").update({ state: "cancelled" }).eq("task_id", taskId).eq("state", "scheduled");
  await save({ ...state, placed: Math.max(0, state.placed - 1), kept: state.kept.filter((id) => id !== taskId) });
  return nextTask(now, `↩ **${task.title}** is back in the inbox.`);
}

/** [📅 Other day] on a task he has just placed: the days again, for that same task. */
export async function otherDay(taskId: number, now = new Date()): Promise<View> {
  const state = await session();
  if (!state) return nextTask(now);
  await setPendingSlot(null).catch(() => undefined);
  const db = requireDb();
  const found = await db.from("tasks").select().eq("id", taskId).maybeSingle();
  const task = found.data as Task | null;
  if (!task) return nextTask(now, "That task is gone, sir.");
  const area = task.project_id ? ((await db.from("projects").select("name").eq("id", task.project_id).maybeSingle()).data as { name?: string } | null)?.name : undefined;
  return dayStep(task, state, now, { area, again: true });
}

/** A tap on a day: the task goes there; then whether it is one of that day's three (if any are free), then its time. */
export async function placeOn(taskId: number, day: string, now = new Date()): Promise<View> {
  const state = await session();
  if (!state) return nextTask(now);
  const before = (await requireDb().from("tasks").select("status, big3_on").eq("id", taskId).maybeSingle()).data as { status: string; big3_on: string | null } | null;
  const placed = await placeAnytime(taskId, day, now);
  if (!placed) return nextTask(now, "That task is gone, sir.");
  // Moved from a day he had just chosen: it leaves that day's three, and is counted once.
  if (before?.big3_on && before.big3_on !== day) await clearBig3(taskId);
  if (before?.status === "inbox") await save({ ...state, placed: state.placed + 1 });
  await updateSettings({ pending_note: null, pending_note_at: null });
  const done = `✓ **${placed.title}** → ${long(day)}.`;
  const taken = await topCount(day);
  // That day's three are taken: straight on to its time.
  if (taken >= BIG3) return timeStep(placed.id, day, now, `${done}\n_${fmt(day, { weekday: "long" })}'s three urgent tasks are already chosen._`);
  return {
    text: [done, "", `One of **${fmt(day, { weekday: "long" })}'s three urgent tasks**? (${taken} of ${BIG3} taken)`].join("\n"),
    rows: [
      [
        { text: "⭐ Yes, urgent", data: `wk:top:${placed.id}:${day}` },
        { text: "Not urgent", data: `wk:time:${placed.id}:${day}` },
      ],
      [
        { text: "📅 Other day", data: `wk:redo:${placed.id}` },
        { text: "↩ Back to inbox", data: `wk:back:${placed.id}` },
      ],
      [{ text: "⏹ Stop", data: "wk:stop" }],
    ],
  };
}

/**
 * The time, asked for every task he puts on a day (26 Nov: "I choose the task, is it important, but after
 * that he's not asking the time"): the free times that day, best first, [No time], or a time he types,
 * which is placed in code.
 */
export async function timeStep(taskId: number, day: string, now = new Date(), lead?: string): Promise<View> {
  const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
  const task = found.data as Task | null;
  if (!task) return nextTask(now, "That task is gone, sir.");
  const options = (await choicesFor({ ...task, due_at: null } as Task, parseLocalDateTime(`${day}T12:00`)!, now).catch(() => [])).filter((option) => option.at.getTime() > now.getTime()).slice(0, 4);
  await setPendingSlot({ task_id: taskId, day });
  return {
    text: [...(lead ? [lead, ""] : []), `**${task.title}** · ${long(day)}`, "", options.length ? "What time, sir? Tap one, or type it (“9:00”, “18:30”)." : "What time, sir? Type it (“9:00”, “18:30”), or leave it with no time.", "_Next task leaves this one as it is and moves on._"].join("\n"),
    rows: [
      ...(options.length ? [options.map((option, index) => ({ text: `${index === 0 ? "⭐ " : ""}${formatTime(option.at)}`, data: `wk:at:${taskId}:${Math.round(option.at.getTime() / 60_000)}` }))] : []),
      [
        { text: "No time", data: "wk:next" },
        { text: "📅 Other day", data: `wk:redo:${taskId}` },
      ],
      [
        { text: "↩ Back to inbox", data: `wk:back:${taskId}` },
        { text: "Next task →", data: "wk:next" },
      ],
      [{ text: "⏹ Stop", data: "wk:stop" }],
    ],
  };
}

/** A tap on a time: the task is set for it (and gets its reminder), then the next task. */
export async function setTime(taskId: number, minute: number, now = new Date()): Promise<View> {
  const placed = await placeTask(taskId, new Date(minute * 60_000), { learn: true });
  return nextTask(now, placed.task?.due_at ? `✓ **${placed.task.title}** → ${long(localDate(new Date(placed.task.due_at)))}, **${formatTime(new Date(placed.task.due_at))}**` : placed.text, taskId);
}

/** [⭐ Yes, urgent]: one of that day's three (three at most), then its time. */
export async function markTop(taskId: number, day: string, now = new Date()): Promise<View> {
  const chosen = await setBig3(taskId, day, now);
  return timeStep(taskId, day, now, chosen.ok ? `⭐ **${chosen.task.title}** is one of ${fmt(day, { weekday: "long" })}'s three.` : `${chosen.error}, sir.`);
}

/** [📥 Keep in inbox], [🌙 Someday], [🗑 Drop]: settled without a day, then the next task. */
export async function settle(taskId: number, how: "keep" | "some" | "drop", now = new Date()): Promise<View> {
  const state = await session();
  if (!state) return nextTask(now);
  const db = requireDb();
  const found = await db.from("tasks").select("id, title").eq("id", taskId).maybeSingle();
  const title = (found.data as { title?: string } | null)?.title ?? "It";
  if (how === "keep") {
    await save({ ...state, kept: [...state.kept, taskId] });
    return nextTask(now, `📥 **${title}** stays in the inbox.`);
  }
  if (how === "some") {
    await db.from("tasks").update({ free_time: true }).eq("id", taskId);
    await clearBig3(taskId);
    await save({ ...state, someday: state.someday + 1 });
    return nextTask(now, `🌙 **${title}** → Free Time, for a free moment.`);
  }
  await db.from("tasks").update({ status: "dropped" }).eq("id", taskId);
  await save({ ...state, dropped: state.dropped + 1 });
  return nextTask(now, `🗑 **${title}** dropped. (/undo brings it back.)`);
}

/** The end, or [⏹ Stop]: what was done, and how each day of the week now stands. */
export async function summary(now = new Date(), lead?: string): Promise<View> {
  const state = await session();
  await save(null);
  await updateSettings({ pending_note: null, pending_note_at: null });
  if (!state) return { text: "Planning stopped, sir.", rows: [] };
  const today = localDate(now);
  const days = daysLeft(state.week, today);
  const { data } = await requireDb().from("tasks").select("due_at, big3_on, kind").in("status", OPEN_STATUSES).not("due_at", "is", null);
  const rows = ((data ?? []) as { due_at: string; big3_on: string | null; kind: string | null }[]).filter((row) => row.kind !== "prayer");
  const lines = days.map((day) => {
    const count = rows.filter((row) => localDate(new Date(row.due_at)) === day).length;
    const top = rows.filter((row) => row.big3_on === day).length;
    return `${short(day)} · ${count} ${count === 1 ? "task" : "tasks"}${top ? ` · ⭐ ${top}` : ""}`;
  });
  const { app_url } = await getSettings();
  const did = [state.placed ? `${state.placed} placed` : undefined, state.kept.length ? `${state.kept.length} kept in the inbox` : undefined, state.someday ? `${state.someday} for someday` : undefined, state.dropped ? `${state.dropped} dropped` : undefined].filter(Boolean).join(", ");
  return {
    text: [...(lead ? [lead, ""] : []), `🗓 **Week planned, sir** · ${weekSpan(state.week)}`, did || "Nothing was changed.", "", ...lines].join("\n"),
    rows: app_url?.startsWith("https://") ? [[{ text: "Open the calendar", data: `url:${app_url.replace(/\/$/, "")}/?tab=week` }]] : [],
  };
}

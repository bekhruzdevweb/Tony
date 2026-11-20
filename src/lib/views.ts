import "server-only";
import { InlineKeyboard } from "grammy";
import { requireDb } from "./db";
import { b, code, esc, expandable, i } from "./html";
import { isPrayer, OPEN_STATUSES, type Task } from "./tasks";
import { addMinutes, dayBounds, formatTime, localDate, TIMEZONE } from "./time";

/**
 * Tony's structured Telegram messages: the day as a checklist, the inbox,
 * and the lines they are built from. All user text is escaped here.
 */
type Project = { id: number; name: string };

const DAY_MS = 24 * 60 * 60_000;
const MAX_BUTTONS = 12;

const shortDay = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
const weekday = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" }).format(at);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function loadProjects(): Promise<Project[]> {
  const { data, error } = await requireDb().from("projects").select("id, name");
  if (error) throw new Error(`loadProjects: ${error.message}`);
  return data as Project[];
}

/**
 * One task as a line: <code>18:00</code>  Workout 🔔 · <i>Health</i>
 * `stamp` is what goes in the time column (a time, or "Wed 21:30" for an overdue task).
 */
export function taskLine(task: Task, projects: Project[], stamp: string): string {
  const project = projects.find((p) => p.id === task.project_id);
  return [code(stamp), " ", esc(task.title), task.persistent ? " 🔔" : "", project ? ` · ${i(project.name)}` : ""].join("");
}

export type DayView = {
  html: string;
  keyboard: InlineKeyboard;
  overdue: Task[];
  open: Task[];
  done: Task[];
};

/** YYYYMMDD, the form a day takes inside a button. */
export const dayKey = (at: Date) => localDate(at).replace(/-/g, "");
export const dayFromKey = (key: string) => new Date(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T12:00:00+05:00`);

/**
 * A day as a checklist: what is overdue, what is to do, what is done, and a
 * button per task that ticks it off (or unticks it) in place.
 */
export async function dayView(day: Date, now = new Date(), options: { title?: string; lead?: string } = {}): Promise<DayView> {
  const db = requireDb();
  const { start, end } = dayBounds(day);
  const isToday = localDate(day) === localDate(now);
  const [openRows, doneRows, projects] = await Promise.all([
    db.from("tasks").select().in("status", OPEN_STATUSES).lt("due_at", end.toISOString()).order("due_at"),
    db.from("tasks").select().eq("status", "done").gte("completed_at", start.toISOString()).lt("completed_at", end.toISOString()).order("completed_at"),
    loadProjects(),
  ]);
  for (const result of [openRows, doneRows]) if (result.error) throw new Error(`dayView: ${result.error.message}`);

  // Prayers have their own calm line on the board; they are not in the day's task list.
  const dated = (openRows.data as Task[]).filter((task) => !isPrayer(task));
  const due = (task: Task) => new Date(task.due_at!).getTime();
  // Overdue means past its time and not started; for a future day, anything from before that day.
  const cutoff = isToday ? now.getTime() : start.getTime();
  const overdue = isToday || day.getTime() < now.getTime() ? dated.filter((t) => due(t) < cutoff && t.status !== "in_progress") : [];
  const open = dated.filter((t) => !overdue.includes(t) && due(t) >= start.getTime());
  const done = doneRows.data as Task[];

  const name = options.title ?? (isToday ? "Today" : localDate(day) === localDate(addMinutes(now, 24 * 60)) ? "Tomorrow" : weekday(day));
  const total = overdue.length + open.length + done.length;
  const parts: string[] = [`<b>${isToday ? "📅" : "🗓"} ${esc(name)} · ${esc(shortDay(day))}</b>`];
  if (options.lead) parts[0] = `${esc(options.lead)}\n${parts[0]}`;
  if (total === 0) parts.push("Nothing planned, sir.");
  else if (done.length > 0) parts.push(i(`${done.length} of ${total} done`));

  if (overdue.length > 0) {
    parts.push(
      [`⚠️ ${b("Overdue")}`, ...overdue.map((task) => taskLine(task, projects, now.getTime() - due(task) < DAY_MS && localDate(new Date(task.due_at!)) === localDate(now) ? formatTime(new Date(task.due_at!)) : `${weekday(new Date(task.due_at!))} ${formatTime(new Date(task.due_at!))}`))].join("\n"),
    );
  }
  if (open.length > 0) {
    parts.push([b("To do"), ...open.map((task) => `${taskLine(task, projects, formatTime(new Date(task.due_at!)))}${task.status === "in_progress" ? ` · ${i("started")}` : ""}`)].join("\n"));
  }
  if (done.length > 0) {
    const lines = [`✅ ${b("Done")}`, ...done.map((task) => `${code(formatTime(new Date(task.completed_at!)))} ${esc(task.title)}`)].join("\n");
    // A long done list folds away; a short one is pleasant to see.
    parts.push(done.length > 3 ? expandable(lines) : lines);
  }

  const key = dayKey(day);
  const keyboard = new InlineKeyboard();
  for (const task of [...overdue, ...open].slice(0, MAX_BUTTONS)) {
    keyboard.text(`☐ ${formatTime(new Date(task.due_at!))}  ${clip(task.title, 34)}`, `ck:${key}:${task.id}`).row();
  }
  for (const task of done.slice(-3)) keyboard.text(`☑ ${clip(task.title, 38)}`, `ck:${key}:${task.id}`).row();

  return { html: parts.join("\n\n"), keyboard, overdue, open, done };
}

/** The inbox: undated tasks, oldest first, with their age once it shows. */
export async function inboxView(now = new Date()): Promise<{ html: string; count: number }> {
  const { data, error } = await requireDb().from("tasks").select().eq("status", "inbox").order("created_at").order("id");
  if (error) throw new Error(`inboxView: ${error.message}`);
  const tasks = data as Task[];
  if (tasks.length === 0) return { html: `<b>📥 Inbox</b>\n\nEmpty, sir.`, count: 0 };
  const line = (task: Task) => {
    const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY_MS);
    return `• ${esc(task.title)}${days > 3 ? ` ${i(`${days} days`)}` : ""}`;
  };
  const lines = tasks.slice(0, 40).map(line);
  if (tasks.length > 40) lines.push(i(`…and ${tasks.length - 40} more`));
  // A long inbox folds away after its first few lines.
  const body = lines.length > 6 ? `${lines.slice(0, 3).join("\n")}\n${expandable(lines.slice(3).join("\n"))}` : lines.join("\n");
  return { html: `<b>📥 Inbox · ${tasks.length}</b>\n\n${body}`, count: tasks.length };
}

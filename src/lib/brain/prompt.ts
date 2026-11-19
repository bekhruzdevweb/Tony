import type { Task } from "../tasks";
import { addMinutes, formatDue, formatLongDate, formatTime, localDate } from "../time";

export type MemoryFact = { id: number; fact: string };
export type ProjectRef = { id: number; name: string };
export type ReminderFact = { task_id: number; state: string; fire_at: string; sent_at: string | null };

/** The spec's system prompt, with a section on how to use the tools. */
const TEMPLATE = `You are Tony, the personal AI agent of Behruzbek, an English teacher and content creator in Tashkent (Asia/Tashkent, UTC+5).

Character: a calm, polite, quietly witty butler in the style of Jarvis. Address the user as "sir". Speak English.

Your job: capture his tasks, keep them organised, and make sure nothing he planned is forgotten. You work through tools; never claim you did something unless a tool call succeeded.

Style:
- Reply in 1-3 short sentences. Lock-screen length. Plain text, no markdown.
- Confirm each action briefly, with the exact time and date you set.
- If the time or task is ambiguous, ask one short question.
- Be persistent about important tasks but never guilt-trip. No lectures.
- At most one emoji, and only occasionally.
- Say "sir" once per reply, not in every sentence.
- Say each thing once. Never confirm the same action twice in different words.

Rules:
- Today is {today}, current time {now}. Resolve relative dates ("tomorrow", "Monday") against this, using the calendar below. A weekday name means its next occurrence.
- Use the memory notes below to personalise suggestions, but do not recite them.
- Never invent tasks, times or facts.

Tools:
- Times you pass to tools are local Tashkent time, written YYYY-MM-DDTHH:MM (24-hour).
- "6" or "at 6" without am/pm: choose the next sensible one (18:00 for a workout or anything evening-like, 06:00 only if he clearly means morning); if it is a real toss-up, ask.
- A request with a time ("remind me to work out at 6 pm") is add_task with due_at. With no date or time it is add_task without due_at, which puts it in the inbox; do not ask for a time he did not offer.
- But if he asks to be reminded and names neither day nor time, or names an event you cannot place, ask one short question instead of guessing.
- Use persistent mode for workouts and for anything he calls important or says he must not miss; say "persistent mode on" when you set it.
- Set a project only when it obviously fits one of: {projects}.
- To change, complete or drop a task, use its number from the list below. If more than one task could be meant, ask which.
- Changing or deleting one task: act, then confirm. Dropping several tasks at once: ask first.
- When he tells you a lasting fact or preference about himself ("I work out in the evenings"), call remember. When he asks you to forget one, call forget.
- Questions like "what's left today?" are answered from the list below or with list_tasks; do not create a task for them.
- Only create, change, complete or drop a task when this message clearly asks for it. A question, a complaint, a remark or a thank-you is never a request: answer it in words and call no tool.
- If he says a reminder did not arrive ("you didn't remind me"), do not reschedule or create anything. Apologise in a few words, say what the record below shows for that task (reminder sent at a time, still pending, or none), and offer to remind him now or at a time he names. Act only after he says yes.
- Never add a task that is already in the open list; if he wants it at a different time, update that task.
- When you call a tool, write no text alongside it. Once the tools have finished, reply once with a short confirmation in your own voice. If a tool fails, say so plainly.

Calendar:
{calendar}

Memory notes:
{memory}

Open tasks:
{task_summary}

Examples of your tone and length:
User: Remind me to work out at 6 p.m.
Tony: Noted, sir. Workout today at 18:00, persistent mode on.
User: remind me about the meeting
Tony: Of course, sir. Which day and time is the meeting?
User: what's left today?
Tony: Two items, sir: Unit 5 slides and the workout at 18:00.
User: buy a notebook
Tony: Noted, sir. "Buy a notebook" is in the inbox.
User: move the slides to tomorrow morning at 9
Tony: Done, sir. Unit 5 slides moved to tomorrow at 09:00.
User: I've done the reading
Tony: Excellent, sir. Reading is off the list.
User: I work out in the evenings, remember that
Tony: Noted, sir: evenings for workouts.
User: u didn't send me the reminder tho?
Tony: My apologies, sir. The 21:30 reminder for the reading was due but did not go out. Shall I remind you now?`;

/** "reminder sent today 21:32", "next reminder today 22:33", or "no reminder set". */
function reminderNote(task: Task, reminders: ReminderFact[], now: Date): string | undefined {
  if (!task.due_at) return undefined;
  const mine = reminders.filter((r) => r.task_id === task.id);
  const sent = mine.find((r) => r.sent_at);
  const pending = mine.filter((r) => r.state === "scheduled").sort((a, b) => a.fire_at.localeCompare(b.fire_at))[0];
  const notes: string[] = [];
  if (sent?.sent_at) notes.push(`last reminder sent ${formatDue(new Date(sent.sent_at), now)}`);
  if (pending) {
    const at = new Date(pending.fire_at);
    notes.push(at.getTime() < now.getTime() - 90_000 ? `reminder due ${formatDue(at, now)} has NOT gone out yet` : `next reminder ${formatDue(at, now)}`);
  }
  return notes.length ? notes.join(", ") : "no reminder sent or pending";
}

export function taskLine(task: Task, projects: ProjectRef[], now: Date, reminders?: ReminderFact[]): string {
  const parts = [`#${task.id} ${task.title}`];
  parts.push(task.due_at ? formatDue(new Date(task.due_at), now) : "inbox, no date");
  if (task.status === "in_progress") parts.push("started");
  if (task.due_at && new Date(task.due_at).getTime() < now.getTime() && task.status !== "in_progress") parts.push("overdue");
  if (task.persistent) parts.push("persistent");
  if (task.priority < 4) parts.push(`P${task.priority}`);
  if (task.repeat_rule) parts.push(`repeats ${task.repeat_rule}`);
  const project = projects.find((p) => p.id === task.project_id);
  if (project) parts.push(project.name);
  const note = reminders ? reminderNote(task, reminders, now) : undefined;
  if (note) parts.push(note);
  return parts.join(" | ");
}

export function buildSystemPrompt(input: {
  now: Date;
  memory: MemoryFact[];
  tasks: Task[];
  projects: ProjectRef[];
  reminders?: ReminderFact[];
}): string {
  const { now, memory, tasks, projects, reminders } = input;
  const calendar = Array.from({ length: 14 }, (_, i) => {
    const day = addMinutes(now, i * 24 * 60);
    const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    return `${formatLongDate(day)} = ${localDate(day)}${label}`;
  }).join("\n");

  const fill: Record<string, string> = {
    today: `${formatLongDate(now)} (${localDate(now)})`,
    now: formatTime(now),
    projects: projects.length ? projects.map((p) => p.name).join(", ") : "(none yet)",
    calendar,
    memory: memory.length ? memory.map((m) => `[${m.id}] ${m.fact}`).join("\n") : "(none yet)",
    task_summary: tasks.length ? tasks.map((t) => taskLine(t, projects, now, reminders)).join("\n") : "(no open tasks)",
  };
  return TEMPLATE.replace(/\{(\w+)\}/g, (whole, key: string) => fill[key] ?? whole);
}

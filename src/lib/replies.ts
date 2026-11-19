import type { Task } from "./tasks";
import { formatTime } from "./time";

const DAY = 24 * 60 * 60_000;
const LIST_LIMIT = 30;

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function lines(tasks: Task[], line: (task: Task) => string): string {
  const shown = tasks.slice(0, LIST_LIMIT).map((task) => `• ${line(task)}`);
  const hidden = tasks.length - shown.length;
  if (hidden > 0) shown.push(`…and ${hidden} more.`);
  return shown.join("\n");
}

export function inboxMessage(tasks: Task[], now = new Date()): string {
  if (tasks.length === 0) return "The inbox is empty, sir.";
  const body = lines(tasks, (task) => {
    const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY);
    // Spec: items older than 3 days carry an age badge.
    return days > 3 ? `${task.title} (${days} days)` : task.title;
  });
  return `Inbox, sir: ${count(tasks.length, "item")}.\n${body}`;
}

export function todayMessage({ overdue, today }: { overdue: Task[]; today: Task[] }): string {
  if (overdue.length === 0 && today.length === 0) return "Nothing scheduled for today, sir.";
  const sections: string[] = [];
  if (today.length > 0) {
    sections.push(
      `Today, sir: ${count(today.length, "task")}.\n` +
        lines(today, (task) => `${formatTime(new Date(task.due_at!))} ${task.title}`),
    );
  } else {
    sections.push("Nothing scheduled for today, sir.");
  }
  if (overdue.length > 0) {
    sections.push(`Carried over: ${count(overdue.length, "item")}.\n` + lines(overdue, (task) => task.title));
  }
  return sections.join("\n\n");
}

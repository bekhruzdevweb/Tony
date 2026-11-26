import type { Task } from "./tasks";

/**
 * Tasks that belong to one day and are never carried to another (27 Nov: "I cannot train legs and push in the
 * same day"): a workout session. Missed, it is just not done: it is not overdue, no button or plan moves it,
 * and he decides whether to do it, skip it or move it himself.
 */
export function staysPut(task: Pick<Task, "title" | "tags" | "kind">): boolean {
  return task.kind === "workout" || (task.tags ?? []).includes("workout") || /^workout\b/i.test(task.title);
}

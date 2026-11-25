/** Today's Big 3 (Phase Q, 25 Nov): "I should be able to choose only 3 important tasks per day". Pure rules. */
export const BIG3 = 3;

type Dated = { id: number; status: string; big3_on?: string | null; completed_at?: string | null };

/** The tasks chosen for a day, open ones first. */
export function big3For<T extends Dated>(tasks: T[], day: string): T[] {
  const open = (task: T) => task.status === "inbox" || task.status === "todo" || task.status === "in_progress";
  return tasks.filter((task) => task.big3_on === day && task.status !== "dropped").sort((a, b) => Number(!open(a)) - Number(!open(b)) || a.id - b.id);
}

/** Whether a chosen task is finished for its day: done, or (a repeating one) completed on that day and moved on. */
export function big3Done(task: Dated, day: string, localDateOf: (iso: string) => string): boolean {
  if (task.status === "done") return true;
  return Boolean(task.completed_at && localDateOf(task.completed_at) === day);
}

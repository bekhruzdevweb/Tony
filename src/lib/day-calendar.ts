import type { Task } from "./tasks";
import { localDate, minuteOfDay } from "./time";

/** One task as a block on a day's timeline: where it starts, how long it runs, and its column among clashes. */
export type DayBlock = { task: Task; start: number; minutes: number; column: number; columns: number };

/** A block with no duration still needs room to be read and tapped. */
export const DEFAULT_BLOCK_MINUTES = 30;
const live = (task: Task) => task.status !== "dropped" && task.status !== "skipped";

/** A day (YYYY-MM-DD) split for the calendar: timed blocks laid out side by side where they overlap, no-time tasks, prayers. */
export function layoutDay(tasks: Task[], day: string): { blocks: DayBlock[]; anytime: Task[]; prayers: Task[] } {
  const onDay = tasks.filter((task) => task.due_at && live(task) && localDate(new Date(task.due_at)) === day);
  const prayers = onDay.filter((task) => task.kind === "prayer");
  const anytime = onDay.filter((task) => task.kind !== "prayer" && task.anytime);
  const timed = onDay
    .filter((task) => task.kind !== "prayer" && !task.anytime)
    .map((task) => ({ task, start: minuteOfDay(new Date(task.due_at!)), minutes: Math.max(task.duration_minutes ?? DEFAULT_BLOCK_MINUTES, 15), column: 0, columns: 1 }))
    .sort((a, b) => a.start - b.start || b.minutes - a.minutes);

  // Tasks that overlap share the width: each takes the first column that is free at its start.
  let cluster: DayBlock[] = [];
  let clusterEnd = -1;
  const close = () => {
    const columns = Math.max(0, ...cluster.map((block) => block.column)) + 1;
    for (const block of cluster) block.columns = columns;
    cluster = [];
  };
  for (const block of timed) {
    if (cluster.length && block.start >= clusterEnd) close();
    const taken = new Set(cluster.filter((other) => other.start + other.minutes > block.start).map((other) => other.column));
    let column = 0;
    while (taken.has(column)) column++;
    block.column = column;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.start + block.minutes);
  }
  if (cluster.length) close();
  return { blocks: timed, anytime, prayers };
}

/** The hours the timeline shows: his waking day, widened to fit anything earlier or later. */
export function hourRange(blocks: DayBlock[], prayers: Task[]): { from: number; to: number } {
  const starts = [...blocks.map((block) => block.start), ...prayers.map((task) => minuteOfDay(new Date(task.due_at!)))];
  const ends = blocks.map((block) => block.start + block.minutes);
  const from = Math.min(7, ...starts.map((minute) => Math.floor(minute / 60)));
  const to = Math.min(24, Math.max(23, ...ends.map((minute) => Math.ceil(minute / 60))));
  return { from, to };
}

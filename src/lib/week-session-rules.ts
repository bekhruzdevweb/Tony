/**
 * The guided weekly planning's rules (Phase R, 26 Nov), pure so they are tested without a database.
 * One task at a time, never a list: each waiting task is shown alone with the days it can go on.
 */
import { shiftDay } from "./week-rules";

export type WeekSession = { week: string; kept: number[]; placed: number; someday: number; dropped: number };

/** The days of the session's week that are still ahead (today included). */
export function daysLeft(week: string, today: string): string[] {
  return Array.from({ length: 7 }, (_, index) => shiftDay(week, index)).filter((day) => day >= today);
}

type Waiting = { id: number; status: string; free_time?: boolean | null; kind?: string | null; project_id: number | null };

/** The inbox tasks still to ask about, area by area in his areas' order, then the ones with no area; oldest first. */
export function queue<T extends Waiting>(tasks: T[], kept: number[], areaOrder: number[]): T[] {
  const rank = (task: T) => (task.project_id === null ? areaOrder.length : areaOrder.indexOf(task.project_id) < 0 ? areaOrder.length : areaOrder.indexOf(task.project_id));
  return tasks.filter((task) => task.status === "inbox" && !task.free_time && task.kind !== "prayer" && !kept.includes(task.id)).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

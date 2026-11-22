import "server-only";
import { requireDb } from "./db";
import { decideFor } from "./routine";
import type { SlotOption } from "./routine-rules";
import { firstFreeDay, LOOK_AHEAD_DAYS, startDate } from "./smart-inbox-rules";
import { OPEN_STATUSES, isPrayer, type Task } from "./tasks";
import { addMinutes, localDate, parseLocalDateTime } from "./time";

export { fullNote, DAY_TASK_LIMIT } from "./smart-inbox-rules";

/**
 * The smart inbox (Phase I, 23 Nov: "he should act smartly and suggest me a
 * specific time. Then I just click and it saves until that day"). A thing to
 * do with no day gets one suggestion: the first day from today (or tomorrow,
 * late in the evening) that is not already full, at the best free time there,
 * with the other free times that day. Nothing is set until he taps.
 */
export type Suggestion = { day: string; options: SlotOption[]; full: string[] };

/** Open tasks per day (prayers do not count), from a date for `days` days. */
export async function dayLoads(from: string, days: number, exclude?: number): Promise<Map<string, number>> {
  const start = parseLocalDateTime(`${from}T00:00`)!;
  const { data, error } = await requireDb()
    .from("tasks")
    .select("id, due_at, kind")
    .in("status", OPEN_STATUSES)
    .gte("due_at", start.toISOString())
    .lt("due_at", addMinutes(start, days * 24 * 60).toISOString());
  if (error) throw new Error(`dayLoads: ${error.message}`);
  const loads = new Map<string, number>();
  for (const row of (data ?? []) as Pick<Task, "id" | "due_at" | "kind">[]) {
    if (row.id === exclude || isPrayer(row) || !row.due_at) continue;
    const day = localDate(new Date(row.due_at));
    loads.set(day, (loads.get(day) ?? 0) + 1);
  }
  return loads;
}

/**
 * The soonest day with room for this task and its free times there. `after`
 * starts the search the day after a date (his [📅 Later day]). Undefined when
 * nothing in the next two weeks has room.
 */
export async function soonestSlot(task: Pick<Task, "id" | "title"> & Partial<Pick<Task, "duration_minutes" | "project_id">>, now = new Date(), options: { after?: string; from?: string } = {}): Promise<Suggestion | undefined> {
  const first = options.after
    ? localDate(addMinutes(parseLocalDateTime(`${options.after}T12:00`)!, 24 * 60))
    : (options.from ?? startDate(now));
  const loads = await dayLoads(first, LOOK_AHEAD_DAYS, task.id);
  const full: string[] = [];
  let date = first;
  for (let n = 0; n < LOOK_AHEAD_DAYS; n++, date = localDate(addMinutes(parseLocalDateTime(`${date}T12:00`)!, 24 * 60))) {
    if (!firstFreeDay(date, loads, 1)) {
      full.push(date);
      continue;
    }
    const decision = await decideFor(task, parseLocalDateTime(`${date}T12:00`)!, now);
    const choices = decision.decision === "ask" || decision.decision === "auto" ? decision.options.filter((option) => option.at.getTime() > now.getTime() + 10 * 60_000) : [];
    if (choices.length) return { day: date, options: choices.slice(0, 3), full };
    // No free time that day after all (long blocks, or the day is nearly over): it counts as full too.
    if (date !== localDate(now)) full.push(date);
  }
  return undefined;
}

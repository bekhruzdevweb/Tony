/**
 * The weekly planner's rules (Phase P, 25 Nov), pure so they are tested without a database.
 * A week runs Monday to Sunday. On Sunday he plans the week ahead, so the planner opens on next week.
 */
export const MAX_WEEK_GOALS = 5;
const DAY_MS = 24 * 60 * 60_000;
const asDate = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (at: Date) => at.toISOString().slice(0, 10);

/** The Monday (YYYY-MM-DD) of the week a day falls in. */
export function weekStart(day: string): string {
  const at = asDate(day);
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return iso(new Date(at.getTime() - sinceMonday * DAY_MS));
}

/** A day shifted by whole days. */
export const shiftDay = (day: string, days: number): string => iso(new Date(asDate(day).getTime() + days * DAY_MS));

/** The week the planner opens on: next week on a Sunday, this week otherwise. */
export function planningWeek(today: string): string {
  const monday = weekStart(today);
  return asDate(today).getUTCDay() === 0 ? shiftDay(monday, 7) : monday;
}

/** "this" or "next" (or a date in it) as that week's Monday. */
export function weekNamed(which: unknown, today: string): string {
  const said = typeof which === "string" ? which.trim().toLowerCase() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(said)) return weekStart(said);
  if (said === "next") return shiftDay(weekStart(today), 7);
  if (said === "this") return weekStart(today);
  return planningWeek(today);
}

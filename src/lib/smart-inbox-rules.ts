import { asksForATime } from "./calm";
/**
 * The smart inbox's rules (Phase I), pure so they are tested without a
 * database: how full a day may get, where the search starts, and how the
 * skipped days are named.
 */
import { addMinutes, formatDay, isNight, localDate, minuteOfDay, parseLocalDateTime } from "./time";

/** A day with this many tasks (prayers not counted) is full: a new thing goes to a later day. */
export const DAY_TASK_LIMIT = 7;
/** How far ahead Tony looks for a day with room. */
export const LOOK_AHEAD_DAYS = 14;
/** After this hour a new thing is suggested for tomorrow, not tonight. */
export const LATE_HOUR = 20;

/** The first day to look at: today, or tomorrow late in the evening; after midnight, the coming morning. */
export function startDate(now: Date): string {
  if (isNight(now)) return localDate(now);
  if (minuteOfDay(now) >= LATE_HOUR * 60) return localDate(addMinutes(now, 24 * 60));
  return localDate(now);
}

const nextDate = (date: string) => localDate(addMinutes(parseLocalDateTime(`${date}T12:00`)!, 24 * 60));

/** The first date from `from` with fewer than the limit, and the full days passed on the way. */
export function firstFreeDay(from: string, loads: Map<string, number>, days: number, limit = DAY_TASK_LIMIT): { day: string; skipped: string[] } | undefined {
  const skipped: string[] = [];
  let date = from;
  for (let n = 0; n < days; n++) {
    if ((loads.get(date) ?? 0) < limit) return { day: date, skipped };
    skipped.push(date);
    date = nextDate(date);
  }
  return undefined;
}

/** "Mon 23 Nov is full." / "Mon 23 and Tue 24 Nov are full." / "The next 4 days are full." */
export function fullNote(full: string[], now: Date): string {
  if (full.length === 0) return "";
  if (full.length > 3) return `The next ${full.length} days are full.`;
  const names = full.map((date) => formatDay(parseLocalDateTime(`${date}T12:00`)!, now));
  if (names.length === 1) return `${names[0]} is full.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are full.`;
}

/**
 * Whether a new thing with no day gets Tony's suggested day. Since Phase N (25 Nov) only when he asks for one:
 * otherwise it is captured to the inbox with one line and no question, and never when he said to keep it
 * unplanned ("put it in the inbox", "someday", "no time", "just save it").
 */
export function wantsSuggestion(said: string): boolean {
  return !keepsUnplanned(said) && asksForATime(said);
}

/** He said to keep it unplanned: no suggestion and no buttons, only the receipt. */
export function keepsUnplanned(said: string): boolean {
  return /\b(inbox|someday|some day|one day|no (time|date|day)|without (a )?(time|date|day)|just (save|keep|note)|don'?t (schedule|plan)|not now|no rush)\b/i.test(said);
}

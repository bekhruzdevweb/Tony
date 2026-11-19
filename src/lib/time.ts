/** Tony's user lives in one timezone (spec: Asia/Tashkent). */
export const TIMEZONE = "Asia/Tashkent";

/** Minutes the zone is ahead of UTC at the given instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The start and end (exclusive) of the local day that contains `now`. */
export function dayBounds(now = new Date(), timeZone = TIMEZONE): { start: Date; end: Date } {
  const offset = offsetMinutes(now, timeZone) * 60_000;
  const local = new Date(now.getTime() + offset);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = new Date(startLocal - offset);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

/** "18:00" in the user's timezone. */
export function formatTime(at: Date, timeZone = TIMEZONE): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

const MINUTE = 60_000;

/** Minutes since local midnight, 0-1439. */
export function minuteOfDay(at: Date, timeZone = TIMEZONE): number {
  const [h, m] = formatTime(at, timeZone).split(":").map(Number);
  return h * 60 + m;
}

/** "23:00" or "23:00:00" to minutes since midnight. */
export function parseClock(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** True when `at` falls in the window [start, end), which may wrap midnight. */
export function inWindow(at: Date, start: string, end: string, timeZone = TIMEZONE): boolean {
  const now = minuteOfDay(at, timeZone);
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE);
}

/** The next full hour that is at least an hour away: 18:30 gives 20:00. */
export function laterThisEvening(now: Date): Date {
  // Whole-hour zones only, which Asia/Tashkent is.
  const hour = 60 * MINUTE;
  return new Date(Math.ceil((now.getTime() + hour) / hour) * hour);
}

/** The nearest whole minute, so reminders are due at :00 and fire on the tick. */
export function toWholeMinute(at: Date): Date {
  return new Date(Math.round(at.getTime() / MINUTE) * MINUTE);
}

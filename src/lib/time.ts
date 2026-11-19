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

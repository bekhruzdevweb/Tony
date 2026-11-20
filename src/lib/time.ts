/** Tony's user lives in one timezone (spec: Asia/Tashkent). */
export const TIMEZONE = "Asia/Tashkent";

/** Minutes the zone is ahead of UTC at the given instant. */
export function offsetMinutes(at: Date, timeZone: string): number {
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

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-19" for the local day that contains `at`. */
export function localDate(at: Date, timeZone = TIMEZONE): string {
  const local = new Date(at.getTime() + offsetMinutes(at, timeZone) * MINUTE);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

/**
 * Reads a time the model wrote. "2026-11-23T18:00" is taken as local time in
 * the user's zone; a value with Z or an offset is taken as written.
 * Returns undefined when it cannot be read.
 */
export function parseLocalDateTime(value: string, timeZone = TIMEZONE): Date | undefined {
  const text = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const exact = new Date(text);
    return Number.isNaN(exact.getTime()) ? undefined : exact;
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (!m) return undefined;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  if (Number.isNaN(asUtc)) return undefined;
  // Two passes settle the offset for zones that change it; one is enough for Tashkent.
  let at = new Date(asUtc - offsetMinutes(new Date(asUtc), timeZone) * MINUTE);
  at = new Date(asUtc - offsetMinutes(at, timeZone) * MINUTE);
  return at;
}

/** "today 18:00", "tomorrow 09:00", "Mon 23 Nov 18:00". */
export function formatDue(at: Date, now = new Date(), timeZone = TIMEZONE): string {
  const day = localDate(at, timeZone);
  const time = formatTime(at, timeZone);
  if (day === localDate(now, timeZone)) return `today ${time}`;
  if (day === localDate(addMinutes(now, 24 * 60), timeZone)) return `tomorrow ${time}`;
  if (day === localDate(addMinutes(now, -24 * 60), timeZone)) return `yesterday ${time}`;
  // Name the year only when it is not this one.
  const year = day.slice(0, 4) === localDate(now, timeZone).slice(0, 4) ? undefined : "numeric";
  const label = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year }).format(at);
  return `${label.replace(",", "")} ${time}`;
}

/** Until this hour he has not slept yet: it is still his previous day. */
export const NIGHT_END_HOUR = 5;

/** Between midnight and 05:00, when "tomorrow" still means the coming morning's date. */
export function isNight(at: Date, timeZone = TIMEZONE): boolean {
  return minuteOfDay(at, timeZone) < NIGHT_END_HOUR * 60;
}

/** The date of the day he is living: before 05:00 it is still the day before ("2026-11-20" at 00:08 on the 21st). */
export function hisDate(now: Date, timeZone = TIMEZONE): string {
  return localDate(isNight(now, timeZone) ? addMinutes(now, -24 * 60) : now, timeZone);
}

/** A moment on his "tomorrow": after midnight (before 05:00) the day just begun, otherwise the next one. */
export function hisTomorrow(now: Date, timeZone = TIMEZONE): Date {
  return isNight(now, timeZone) ? now : addMinutes(now, 24 * 60);
}

/** "Sat 21 Nov" (with the year only when it is not this one). */
export function formatDay(at: Date, now = new Date(), timeZone = TIMEZONE): string {
  const year = localDate(at, timeZone).slice(0, 4) === localDate(now, timeZone).slice(0, 4) ? undefined : "numeric";
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year }).format(at).replace(",", "");
}

/**
 * "today", "tomorrow" or "tonight" for a moment, by the day he is living (at
 * 00:08 on Saturday, Saturday morning is "tomorrow"); undefined for other days.
 */
export function relativeDay(at: Date, now = new Date(), timeZone = TIMEZONE): "today" | "tomorrow" | "tonight" | undefined {
  const day = localDate(at, timeZone);
  if (isNight(now, timeZone) && day === localDate(now, timeZone) && isNight(at, timeZone)) return "tonight";
  const his = hisDate(now, timeZone);
  if (day === his) return "today";
  if (day === localDate(addMinutes(parseLocalDateTime(`${his}T12:00`, timeZone)!, 24 * 60), timeZone)) return "tomorrow";
  return undefined;
}

/** "tomorrow, Sat 21 Nov, 08:30" or "Mon 23 Nov, 10:00": every confirmation names the weekday and the date. */
export function formatWhen(at: Date, now = new Date(), timeZone = TIMEZONE): string {
  const relative = relativeDay(at, now, timeZone);
  return `${relative ? `${relative}, ` : ""}${formatDay(at, now, timeZone)}, ${formatTime(at, timeZone)}`;
}

/** "Thursday 19 November 2026". */
export function formatLongDate(at: Date, timeZone = TIMEZONE): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(at)
    .replace(",", "");
}

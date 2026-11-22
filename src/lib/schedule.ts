/**
 * Finding free time, in plain code. Used by everything that proposes times:
 * new tasks he gave without a time, /plan, and "plan tomorrow".
 *
 * - Busy: every open timed task for its duration (30 minutes if unknown),
 *   and each prayer from 15 minutes before to 15 minutes after.
 * - The day: from the end of quiet hours to their start (07:00 to 23:00).
 * - Order: most important first; deep work goes in the morning, light
 *   tasks from the afternoon; a 10-minute gap is kept between things.
 * No database and no model, so it is tested directly (tests/schedule.test.ts).
 */
const MINUTE = 60_000;
const STEP = 15 * MINUTE;
const GAP = 10 * MINUTE;
const PRAYER_MARGIN = 15 * MINUTE;
const DEFAULT_MINUTES = 30;
/** Light tasks look for room from 13:00 first. */
const AFTERNOON_HOUR = 13;

export type Interval = { start: number; end: number; title?: string };
export type Busy = { due_at: string | null; duration_minutes?: number | null; kind?: string | null; status?: string; title?: string; anytime?: boolean | null };
export type ToPlace = {
  id: number;
  title: string;
  minutes: number;
  priority: number;
  deep: boolean;
  prefer?: Date;
  /** Where it belongs, tried first: around his usual time, its own hours in his routine. */
  within?: Interval[];
  /** Closed to it: his teaching hours, for anything but a class. */
  avoid?: Interval[];
  /** Only these days: the day he gave it ("writing on Monday, reading on Tuesday"). */
  windows?: DayWindow[];
};
export type DayWindow = { start: Date; end: Date };

/** A task's length when he gave none: a sensible guess from its title. */
export function estimateMinutes(title: string): number {
  const t = title.toLowerCase();
  if (/\b(call|phone|text|message|reply|email|e-mail|pay|send|book|buy|order|post (a|the) story|story)\b/.test(t)) return 15;
  if (/\b(read|review|check|plan|tidy|clean)\b/.test(t)) return 30;
  if (/\b(workout|gym|run|exercise|training|lesson|class|meeting|club|presentation|prepare|zoom|tutorial|study|ielts|practice|develop|build|write|edit)\b/.test(t)) return 60;
  if (/\b(film|record|shoot|video|reel|podcast|series)\b/.test(t)) return 90;
  return DEFAULT_MINUTES;
}

/** Deep work (long, important, or thinking work) goes in the morning; the rest later. */
export function isDeep(title: string, minutes: number, priority: number): boolean {
  return minutes >= 60 || priority <= 2 || /\b(prepare|study|write|develop|build|film|record|presentation|ielts|plan)\b/i.test(title);
}

/** The busy stretches of the list: tasks for their duration, prayers ±15 minutes. */
export function busyIntervals(tasks: Busy[]): Interval[] {
  const open = new Set(["inbox", "todo", "in_progress", undefined]);
  return tasks
    // An anytime task (Phase J) holds no time of the day.
    .filter((task) => task.due_at && open.has(task.status) && !task.anytime)
    .map((task) => {
      const at = new Date(task.due_at!).getTime();
      if (task.kind === "prayer") return { start: at - PRAYER_MARGIN, end: at + PRAYER_MARGIN };
      return { start: at, end: at + (task.duration_minutes || DEFAULT_MINUTES) * MINUTE, ...(task.title ? { title: task.title } : {}) };
    });
}

/** The day he is awake for: from the end of quiet hours to their start, in Tashkent time. */
export function dayWindow(day: Date, quietStart: string, quietEnd: string): DayWindow {
  const date = new Date(day.getTime() + 5 * 60 * 60_000).toISOString().slice(0, 10);
  const clock = (value: string) => value.slice(0, 5);
  return { start: new Date(`${date}T${clock(quietEnd)}:00+05:00`), end: new Date(`${date}T${clock(quietStart)}:00+05:00`) };
}

const fits = (start: number, minutes: number, busy: Interval[], window: DayWindow, earliest: number) => {
  const end = start + minutes * MINUTE;
  if (start < earliest || start < window.start.getTime() || end > window.end.getTime()) return false;
  return busy.every((other) => end + GAP <= other.start || start >= other.end + GAP);
};

const roundUp = (time: number) => Math.ceil(time / STEP) * STEP;

/** The first start at or after `from` in this window where `minutes` fit. */
function firstFit(from: number, minutes: number, busy: Interval[], window: DayWindow, earliest: number): number | undefined {
  for (let start = roundUp(Math.max(from, earliest, window.start.getTime())); start + minutes * MINUTE <= window.end.getTime(); start += STEP) {
    if (fits(start, minutes, busy, window, earliest)) return start;
  }
  return undefined;
}

/**
 * Places each item in the first free time that suits it, across the given
 * days in order. Items that fit nowhere are left out. Placed items become
 * busy for the ones after them, so nothing proposed clashes.
 */
export function placeAll(items: ToPlace[], busy: Interval[], windows: DayWindow[], earliest: Date): { placed: { id: number; at: Date }[]; left: number[] } {
  const taken = [...busy];
  const placed: { id: number; at: Date }[] = [];
  const left: number[] = [];
  const order = [...items].sort((a, b) => a.priority - b.priority || Number(b.deep) - Number(a.deep) || b.minutes - a.minutes);
  for (const item of order) {
    const blocked = item.avoid?.length ? [...taken, ...item.avoid] : taken;
    // A task he gave a day stays on that day.
    const open = item.windows?.length ? item.windows : windows;
    let at: number | undefined;
    if (item.prefer && open.some((window) => fits(item.prefer!.getTime(), item.minutes, blocked, window, earliest.getTime()))) at = item.prefer.getTime();
    // Where his routine says it belongs, if there is room there.
    for (const range of item.within ?? []) {
      if (at !== undefined) break;
      for (const window of open) {
        const inside = { start: new Date(Math.max(window.start.getTime(), range.start)), end: new Date(Math.min(window.end.getTime(), range.end)) };
        if (inside.end.getTime() <= inside.start.getTime()) continue;
        at = firstFit(inside.start.getTime(), item.minutes, blocked, inside, earliest.getTime());
        if (at !== undefined) break;
      }
    }
    for (const window of open) {
      if (at !== undefined) break;
      const afternoon = new Date(window.start.getTime());
      const local = new Date(afternoon.getTime() + 5 * 60 * 60_000).toISOString().slice(0, 10);
      const from = item.deep ? window.start.getTime() : new Date(`${local}T${String(AFTERNOON_HOUR).padStart(2, "0")}:00:00+05:00`).getTime();
      at = firstFit(from, item.minutes, blocked, window, earliest.getTime()) ?? firstFit(window.start.getTime(), item.minutes, blocked, window, earliest.getTime());
    }
    if (at === undefined) {
      left.push(item.id);
      continue;
    }
    taken.push({ start: at, end: at + item.minutes * MINUTE });
    placed.push({ id: item.id, at: new Date(at) });
  }
  placed.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { placed, left };
}

/** "today", "tonight", "tomorrow", "day after tomorrow", or a weekday: the day he named, if any. */
export function dayFromText(text: string, now: Date): Date | undefined {
  const t = text.toLowerCase();
  const plus = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60_000);
  // Between midnight and 05:00 he has not slept yet: "tomorrow" is the coming morning's date.
  const tomorrow = new Date(now.getTime() + 5 * 60 * 60_000).getUTCHours() < 5 ? 0 : 1;
  if (/\bday after (tomorrow|tmrw?|tomm?orr?ow)\b|\bindinga\b|послезавтра/.test(t)) return plus(tomorrow + 1);
  if (/\b(tomorrow|tmrw?|tomm?orr?ow|ertaga|ertangi)\b|завтра/.test(t)) return plus(tomorrow);
  if (/\b(today|tonight|this (morning|afternoon|evening)|bugun|bugungi)\b|сегодня/.test(t)) return now;
  // A date: "on 25th", "25 November", "Nov 25", "25-noyabr", "25 ноября" (this year, or next if it has passed).
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const uzMonths = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
  const ruMonths = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
  const local = new Date(now.getTime() + 5 * 60 * 60_000);
  const dated = (day: number, month: number) => {
    if (day < 1 || day > 31) return undefined;
    let year = local.getUTCFullYear();
    const at = (y: number) => new Date(`${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00+05:00`);
    if (at(year).getTime() < now.getTime() - 24 * 60 * 60_000) year += 1;
    const date = at(year);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  const en = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (en) return dated(Number(en[1] ?? en[4]), months.indexOf((en[2] ?? en[3]).slice(0, 3)));
  const uz = /\b(\d{1,2})[-\s]?(yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sentabr|oktabr|noyabr|dekabr)/.exec(t);
  if (uz) return dated(Number(uz[1]), uzMonths.indexOf(uz[2]));
  const ru = /(\d{1,2})\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)/.exec(t);
  if (ru) return dated(Number(ru[1]), ru[2].startsWith("ма") ? 4 : ruMonths.indexOf(ru[2]));
  const nth = /\b(?:on (?:the )?)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (nth) return dated(Number(nth[1]), local.getUTCMonth()) ?? undefined;
  // A weekday, in English, Uzbek or Russian ("on Monday", "dushanba kuni", "в понедельник"); "weekend" is Saturday.
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const uzNames = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
  const ruNames = ["воскресен", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот"];
  let named = names.findIndex((name) => new RegExp(`\\b${name}\\b`).test(t));
  if (named < 0) named = uzNames.findIndex((name) => new RegExp(`(^|[^a-z'])${name}(\\b|kun|ga|da)`).test(t) && !(name === "shanba" && /(yak|du|se|chor|pay)shanba/.test(t)));
  if (named < 0) named = ruNames.findIndex((name) => t.includes(name) && !(name === "сред" && /средн|средств/.test(t)));
  if (named < 0 && /\b(this |the )?weekend\b|dam olish kuni|выходны/.test(t)) {
    // On a Saturday or Sunday, "this weekend" is today; otherwise the coming Saturday.
    if (local.getUTCDay() === 6 || local.getUTCDay() === 0) return now;
    named = 6;
  }
  if (named >= 0) {
    const today = local.getUTCDay();
    return plus(((named - today + 7) % 7) || 7);
  }
  return undefined;
}

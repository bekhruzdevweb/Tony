/**
 * His routine, and how Tony decides when something happens: the pure rules
 * (no database, no model), tested in tests/routine.test.ts.
 *
 * - He gave a time: it is used exactly (see heldToGivenTime).
 * - No time and no day: the inbox. No time is proposed unless he asks.
 * - A day but no time: if his routine clearly fits (he named a part of the
 *   day, he usually does this kind of task at a certain hour, or it has its
 *   own hours in his routine), ONE slot is proposed. Otherwise he is asked
 *   once, with two or three real free slots that fit his routine.
 * - Nothing is ever put where something else already is: every task blocks
 *   its whole duration, prayers ±15 minutes, his teaching hours, his sleep.
 */
const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const STEP = 15;
/** Minutes kept free between two things. */
const GAP = 10;
/** Asia/Tashkent: UTC+5 all year. */
const OFFSET = 5 * 60 * MINUTE;

export type Routine = {
  wake: string;
  sleep: string;
  teaching: string | null;
  content: string | null;
  coding: string | null;
  workout: string | null;
  free_days: string | null;
  /** Per kind of task: the minutes after midnight he moved such tasks to, newest last. */
  learned: Record<string, number[]>;
};
export const DEFAULT_ROUTINE: Routine = { wake: "07:00", sleep: "23:00", teaching: null, content: null, coding: null, workout: null, free_days: null, learned: {} };
export const ROUTINE_FIELDS = ["wake", "sleep", "teaching", "content", "coding", "workout", "free_days"] as const;
export type RoutineField = (typeof ROUTINE_FIELDS)[number];

/** A stretch of the day on some weekdays: minutes after midnight; days 0 = Sunday. */
export type Window = { days: number[]; start: number; end: number };
/** A stretch of real time, in milliseconds. */
export type Interval = { start: number; end: number };
export type Kind = "teaching" | "prep" | "content" | "coding" | "workout" | "learn" | "errand" | "other";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

// ── Reading and writing his routine ─────────────────────────────────────

/** "18:00", "18.30", "18", "6pm", "6.30 p.m.", "noon", "midnight" → minutes after midnight. */
export function parseClockText(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "noon" || t === "midday") return 12 * 60;
  if (t === "midnight") return 0;
  const match = /^(\d{1,2})(?:[:.](\d{2})(?::\d{2})?)?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?$/.exec(t);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const suffix = match[3]?.replace(/[\s.]/g, "");
  if (minute > 59 || hour > 24 || (suffix && (hour < 1 || hour > 12))) return undefined;
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (hour === 24 && minute > 0) return undefined;
  return hour * 60 + minute;
}

export const clockText = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "Mon-Fri", "weekdays", "Sat and Sun", "sunday", "every day" → weekday numbers (0 = Sunday). */
export function parseDays(text: string): number[] | undefined {
  const t = text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (/^(every ?day|daily|all week|each day)$/.test(t)) return EVERY_DAY;
  if (/^weekdays?$/.test(t)) return [1, 2, 3, 4, 5];
  if (/^weekends?$/.test(t)) return [0, 6];
  const index = (word: string) => (word.length >= 2 ? DAY_NAMES.findIndex((name) => word.startsWith(name) || name.startsWith(word)) : -1);
  const days = new Set<number>();
  for (const piece of t.split(/\s*(?:,|&|\band\b)\s*/)) {
    if (!piece) continue;
    const range = /^([a-z]+)\s*(?:-|to|through|till|until)\s*([a-z]+)$/.exec(piece);
    if (range) {
      const from = index(range[1]);
      const to = index(range[2]);
      if (from < 0 || to < 0) return undefined;
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === to) break;
      }
      continue;
    }
    const day = /^[a-z]+$/.test(piece) ? index(piece.replace(/s$/, "")) : -1;
    if (day < 0) return undefined;
    days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** Words for parts of the day, as hours. */
const PARTS: Record<string, [number, number]> = { morning: [8 * 60, 12 * 60], afternoon: [13 * 60, 17 * 60], evening: [18 * 60, 21 * 60], night: [20 * 60, 23 * 60] };

/**
 * "Mon-Fri 14:00-18:00; Sat 10:00-12:00", "10-12", "6-8pm", "evenings",
 * "weekdays 9:00–13:00" → windows. "none" clears. Undefined if unreadable.
 */
export function parseWindows(text: string): Window[] | undefined {
  const t = text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (/^(none|no|nothing|clear|-)$/.test(t)) return [];
  const windows: Window[] = [];
  const CLOCK = "(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)?|noon|midnight)";
  for (const segment of t.split(/\s*(?:;|\n)\s*/)) {
    if (!segment) continue;
    const range = new RegExp(`${CLOCK}\\s*(?:-|to|till|until)\\s*${CLOCK}\\s*$`).exec(segment);
    let start: number | undefined;
    let end: number | undefined;
    let dayText: string;
    if (range) {
      start = parseClockText(range[1]);
      end = parseClockText(range[2]);
      // "6-8pm": the start shares the end's afternoon.
      if (start !== undefined && end !== undefined && /p/.test(range[2]) && !/[ap]/.test(range[1]) && start < 12 * 60 && start + 12 * 60 < end) start += 12 * 60;
      dayText = segment.slice(0, range.index).replace(/\b(from|at|on|between)\b/g, "").trim();
    } else {
      const part = /(mornings?|afternoons?|evenings?|nights?)$/.exec(segment);
      if (!part) return undefined;
      [start, end] = PARTS[part[1].replace(/s$/, "")];
      dayText = segment.slice(0, part.index).replace(/\b(in the|on|the)\b/g, "").trim();
    }
    if (start === undefined || end === undefined) return undefined;
    if (end <= start) end += DAY_MINUTES;
    const days = dayText ? parseDays(dayText) : EVERY_DAY;
    if (!days || days.length === 0) return undefined;
    windows.push({ days, start, end });
  }
  return windows;
}

/** Weekdays as he would write them: "every day", "Mon–Fri", "Sat, Sun". */
export function formatDays(days: number[]): string {
  const set = [...new Set(days)];
  if (set.length === 7) return "every day";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const name = (day: number) => DAY_NAMES[day][0].toUpperCase() + DAY_NAMES[day].slice(1);
  const runs: number[][] = [];
  for (const day of order.filter((d) => set.includes(d))) {
    const last = runs[runs.length - 1];
    if (last && order.indexOf(day) === order.indexOf(last[last.length - 1]) + 1) last.push(day);
    else runs.push([day]);
  }
  return runs.map((run) => (run.length >= 3 ? `${name(run[0])}–${name(run[run.length - 1])}` : run.map(name).join(", "))).join(", ");
}

/** Windows as stored and shown: "Mon–Fri 14:00–18:00; Sat 10:00–12:00", or "18:00–20:00" for every day. */
export function formatWindows(windows: Window[]): string {
  return windows
    .map((window) => {
      const days = formatDays(window.days);
      return `${days === "every day" ? "" : `${days} `}${clockText(window.start)}–${clockText(window.end)}`;
    })
    .join("; ");
}

/** The stretches of one weekday that a routine field covers. */
export function windowsOn(text: string | null | undefined, weekday: number): { start: number; end: number }[] {
  return (text ? (parseWindows(text) ?? []) : []).filter((window) => window.days.includes(weekday)).map(({ start, end }) => ({ start, end }));
}

export function isFreeDay(routine: Routine, weekday: number): boolean {
  return Boolean(routine.free_days && parseDays(routine.free_days)?.includes(weekday));
}

/**
 * A routine field set from his words, checked and written the one way it is
 * stored. Undefined when the value cannot be read.
 */
export function normalizeField(field: RoutineField, value: string): string | null | undefined {
  const v = value.trim();
  if (field === "wake" || field === "sleep") {
    const minutes = parseClockText(v);
    return minutes === undefined ? undefined : clockText(minutes);
  }
  if (field === "free_days") {
    if (/^(none|no|nothing|clear|-)$/i.test(v)) return null;
    const days = parseDays(v);
    return days && days.length < 7 ? formatDays(days) : undefined;
  }
  const windows = parseWindows(v);
  if (windows === undefined) return undefined;
  return windows.length ? formatWindows(windows) : null;
}

// ── Kinds of task ───────────────────────────────────────────────────────

/** What sort of task this is, from its title (and project): the key for his routine and for what Tony learns. */
export function kindOf(title: string, project?: string | null): Kind {
  const t = title.toLowerCase();
  if (/^(call|phone|ring|buy|pay|message|text|email|e-mail|reply|send|book|order|pick up|collect|visit|return)\b/.test(t)) return "errand";
  // Watching or reading something is learning, whatever it is about ("Watch: Instagram Masterclass").
  if (/^(watch|read|listen|study|learn|review)\b/.test(t)) return "learn";
  if (/\b(post|posting|story|stories|reels?|shoot|shooting|film|filming|record|recording|vlog|caption|thumbnail|tiktok|instagram|content|tutorial|edit (the |a )?video)\b/.test(t)) return "content";
  if (/\b(code|coding|program|develop|deploy|debug|bug|api|website|web ?site|app|bot|agent|chatbot|features?|github|refactor|database|server)\b/.test(t)) return "coding";
  if (/^(watch|read|listen|study|learn|review)\b|\b(podcast|masterclass|audiobook|article|book)\b/.test(t)) return "learn";
  if (/\b(prepare|preparation|presentation|slides|lesson plan|worksheet|homework|quiz|syllabus|materials|curriculum|course)\b/.test(t)) return "prep";
  if (/\b(lesson|class|classes|teach|teaching|tutoring|students?|speaking club|webinar|seminar)\b/.test(t)) return "teaching";
  if (/\b(workout|work out|gym|run|running|jog|exercise|training|pull-?ups?|push-?ups?|stretch|yoga|swim|cardio)\b/.test(t) && !/\bplan\b/.test(t)) return "workout";
  if (/\b(call|buy|pay|bank|barber|shop|shopping|appointment|doctor|groceries)\b/.test(t)) return "errand";
  const p = (project ?? "").toLowerCase();
  if (p === "teaching") return "prep";
  if (p === "content") return "content";
  if (p === "health") return "workout";
  return "other";
}

/** The routine field that gives a kind its own hours. */
const KIND_FIELD: Partial<Record<Kind, "teaching" | "content" | "coding" | "workout">> = { teaching: "teaching", content: "content", coding: "coding", workout: "workout" };
const KIND_WHY: Partial<Record<Kind, string>> = { teaching: "your teaching hours", content: "your content time", coding: "your coding time", workout: "your workout time" };
const KIND_HABIT: Record<Kind, string> = {
  teaching: "teach",
  prep: "prepare lessons",
  content: "make content",
  coding: "code",
  workout: "work out",
  learn: "watch and read",
  errand: "run errands",
  other: "do these",
};

/** Where a kind of task belongs on a day: around his learned time, then in its own hours (in milliseconds). */
export function preferredRanges(routine: Routine, kind: Kind, day: Date): Interval[] {
  const midnight = localMidnight(day);
  const weekday = weekdayOf(new Date(midnight + 12 * 60 * MINUTE));
  const ranges: Interval[] = [];
  const learned = learnedMinute(routine.learned?.[kind]);
  if (learned !== undefined) ranges.push({ start: midnight + (learned - 30) * MINUTE, end: midnight + (learned + 120) * MINUTE });
  const field = KIND_FIELD[kind];
  if (field && !(field === "teaching" && isFreeDay(routine, weekday))) {
    for (const window of windowsOn(routine[field], weekday)) ranges.push({ start: midnight + window.start * MINUTE, end: midnight + window.end * MINUTE });
  }
  return ranges;
}

/** His teaching hours on a working day, closed to everything but classes (in milliseconds). */
export function blockedRanges(routine: Routine, kind: Kind, day: Date): Interval[] {
  const midnight = localMidnight(day);
  const weekday = weekdayOf(new Date(midnight + 12 * 60 * MINUTE));
  if (kind === "teaching" || isFreeDay(routine, weekday)) return [];
  return windowsOn(routine.teaching, weekday).map((window) => ({ start: midnight + window.start * MINUTE, end: midnight + window.end * MINUTE }));
}

// ── Learning from his moves ─────────────────────────────────────────────

/** The time he keeps moving this kind of task to: the middle of his last moves, once there are two. */
export function learnedMinute(samples: number[] | undefined): number | undefined {
  if (!samples || samples.length < 2) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value / 5) * 5;
}

/** His routine's learned times with one more move added (the last eight are kept). */
export function withSample(learned: Record<string, number[]>, kind: Kind, minute: number): Record<string, number[]> {
  return { ...learned, [kind]: [...(learned[kind] ?? []), minute].slice(-8) };
}

// ── Parts of the day he names ───────────────────────────────────────────

export type Part = { start: number; end: number; label: string };

/** "Sunday afternoon or noon", "tomorrow evening", "tonight": the stretches of the day he meant. */
export function partsOfDay(text: string): Part[] {
  const t = text.toLowerCase();
  const parts: Part[] = [];
  if (/\bmornings?\b/.test(t) && !/\b\d{1,2}([:.]\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?\s+in the morning\b/.test(t)) parts.push({ start: 7 * 60, end: 12 * 60, label: "in the morning" });
  if (/\b(noon|midday|lunch ?time|at lunch)\b/.test(t) && !/\bat (12 )?noon\b/.test(t)) parts.push({ start: 12 * 60, end: 13 * 60 + 30, label: "around noon" });
  if (/\bafternoons?\b/.test(t)) parts.push({ start: 12 * 60, end: 17 * 60, label: "in the afternoon" });
  if (/\bevenings?\b/.test(t)) parts.push({ start: 17 * 60, end: 21 * 60, label: "in the evening" });
  if (/\btonight\b/.test(t)) parts.push({ start: 18 * 60, end: 23 * 60, label: "tonight" });
  else if (/\bnight\b/.test(t)) parts.push({ start: 20 * 60, end: 23 * 60, label: "at night" });
  return parts;
}

// ── Free time ───────────────────────────────────────────────────────────

/** Local midnight (Tashkent) of the day `at` falls on, in milliseconds. */
export function localMidnight(at: Date): number {
  const local = at.getTime() + OFFSET;
  return local - (local % (DAY_MINUTES * MINUTE)) - OFFSET;
}
export const weekdayOf = (at: Date) => new Date(at.getTime() + OFFSET).getUTCDay();
const minutesOf = (routine: Routine) => {
  const wake = parseClockText(routine.wake) ?? 7 * 60;
  let sleep = parseClockText(routine.sleep) ?? 23 * 60;
  if (sleep <= wake) sleep += DAY_MINUTES;
  return { wake, sleep };
};

export type SlotInput = {
  /** How long the task takes; it blocks all of it. */
  minutes: number;
  kind: Kind;
  /** Any moment of the day to schedule. */
  day: Date;
  now: Date;
  routine: Routine;
  /** Everything already there: tasks for their durations, prayers ±15 minutes. */
  busy: Interval[];
  /** The parts of the day he named, if any. */
  parts?: Part[];
};

/**
 * Every start time (15-minute steps) on that day where the task fits whole:
 * awake, not in the past, clear of everything busy by 10 minutes, and out of
 * his teaching hours unless it is a class itself (on a working day).
 */
export function freeStarts(input: SlotInput): number[] {
  const midnight = localMidnight(input.day);
  const weekday = weekdayOf(new Date(midnight + 12 * 60 * MINUTE));
  const { wake, sleep } = minutesOf(input.routine);
  const soonest = Math.ceil((input.now.getTime() + 15 * MINUTE) / (STEP * MINUTE)) * STEP * MINUTE;
  const earliest = Math.max(midnight + wake * MINUTE, soonest);
  const latest = midnight + sleep * MINUTE;
  const blocked = [...input.busy];
  if (input.kind !== "teaching" && !isFreeDay(input.routine, weekday)) {
    for (const window of windowsOn(input.routine.teaching, weekday)) blocked.push({ start: midnight + window.start * MINUTE, end: midnight + window.end * MINUTE });
  }
  const length = input.minutes * MINUTE;
  const starts: number[] = [];
  for (let start = Math.ceil(earliest / (STEP * MINUTE)) * STEP * MINUTE; start + length <= latest; start += STEP * MINUTE) {
    const end = start + length;
    if (blocked.every((other) => end + GAP * MINUTE <= other.start || start >= other.end + GAP * MINUTE)) starts.push(start);
  }
  return starts;
}

/** Up to three free starts spread over the day (morning, afternoon, evening), at least two hours apart. */
export function spreadSlots(starts: number[], midnight: number, count = 3): number[] {
  const minuteOf = (start: number) => (start - midnight) / MINUTE;
  const chosen: number[] = [];
  for (const [from, to] of [
    [0, 12 * 60],
    [12 * 60, 17 * 60],
    [17 * 60, 2 * DAY_MINUTES],
  ]) {
    const first = starts.find((start) => minuteOf(start) >= from && minuteOf(start) < to);
    if (first !== undefined) chosen.push(first);
  }
  for (const start of starts) {
    if (chosen.length >= count) break;
    if (chosen.every((other) => Math.abs(other - start) >= 120 * MINUTE)) chosen.push(start);
  }
  return chosen.sort((a, b) => a - b).slice(0, count);
}

/** Two or three real free slots on that day, for him to choose from. */
export function slotChoices(input: SlotInput): Date[] {
  return spreadSlots(freeStarts(input), localMidnight(input.day)).map((start) => new Date(start));
}

export type Decision = { decision: "propose"; at: Date; why: string } | { decision: "ask"; options: Date[] } | { decision: "none" };

const closest = (starts: number[], target: number) => starts.reduce((best, start) => (Math.abs(start - target) < Math.abs(best - target) ? start : best));

/**
 * A day he named without a time: one slot when his routine clearly fits,
 * otherwise two or three real free slots to choose from, or none if the day
 * is full.
 */
export function decideSlot(input: SlotInput): Decision {
  const starts = freeStarts(input);
  if (starts.length === 0) return { decision: "none" };
  const midnight = localMidnight(input.day);
  const minuteOf = (start: number) => Math.round((start - midnight) / MINUTE);
  const learned = learnedMinute(input.routine.learned[input.kind]);

  // He named a part of the day: that is clear enough. His usual time inside it, else its first free start.
  if (input.parts?.length) {
    const inside = starts.filter((start) => input.parts!.some((part) => minuteOf(start) >= part.start && minuteOf(start) < part.end));
    if (inside.length > 0) {
      const pick = learned !== undefined ? closest(inside, midnight + learned * MINUTE) : inside[0];
      const part = input.parts.find((p) => minuteOf(pick) >= p.start && minuteOf(pick) < p.end)!;
      return { decision: "propose", at: new Date(pick), why: `${part.label}, as you said` };
    }
    // That part of the day is full: the nearest free times, to choose from.
    const target = midnight + input.parts[0].start * MINUTE;
    const near = [...starts].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    const options = spreadSlots(near.slice(0, 12).sort((a, b) => a - b), midnight);
    return options.length === 1 ? { decision: "propose", at: new Date(options[0]), why: "the nearest free time" } : { decision: "ask", options: options.map((start) => new Date(start)) };
  }

  // He keeps moving this kind of task to one time: that time, or the nearest free start within 90 minutes.
  if (learned !== undefined) {
    const target = midnight + learned * MINUTE;
    const near = starts.filter((start) => Math.abs(start - target) <= 90 * MINUTE);
    if (near.length > 0) return { decision: "propose", at: new Date(closest(near, target)), why: `you usually ${KIND_HABIT[input.kind]} around ${clockText(learned)}` };
  }

  // It has its own hours in his routine.
  const field = KIND_FIELD[input.kind];
  if (field) {
    const weekday = weekdayOf(new Date(midnight + 12 * 60 * MINUTE));
    const windows = field === "teaching" && isFreeDay(input.routine, weekday) ? [] : windowsOn(input.routine[field], weekday);
    const inside = starts.filter((start) => windows.some((window) => minuteOf(start) >= window.start && minuteOf(start) + input.minutes <= window.end));
    if (inside.length > 0) return { decision: "propose", at: new Date(inside[0]), why: KIND_WHY[input.kind]! };
  }

  // Not sure: two or three real free slots to choose from.
  const options = spreadSlots(starts, midnight);
  if (options.length === 1) return { decision: "propose", at: new Date(options[0]), why: "the only free time that day" };
  return { decision: "ask", options: options.map((start) => new Date(start)) };
}

/** The free start nearest to `at` (same day, at or after it first), for a time that is taken. */
export function nearestFree(input: SlotInput & { at: Date }): Date | undefined {
  const starts = freeStarts(input);
  if (starts.length === 0) return undefined;
  const target = input.at.getTime();
  if (starts.includes(target)) return input.at;
  const after = starts.filter((start) => start >= target);
  const pick = after.length && after[0] - target <= 3 * 60 * MINUTE ? after[0] : closest(starts, target);
  return new Date(pick);
}

// ── Check-ins: "remind me if I don't check it for 2 days" ───────────────

const COUNT: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };

/** The days in "remind me if I don't check it for 2 days" (or "…haven't touched it in a week"). */
export function checkInDays(text: string): number | undefined {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  const match =
    /\b(?:if|when|in case)\s+i\s+(?:do\s*n'?o?t|don'?t|dont|did\s*n'?o?t|didn'?t|haven'?t|have not|never)\s+(?:check|touch|do|open|look at|see|start|finish|get to|complete|work on)(?:ed|es|s|ing)?\b[^.?!]{0,30}?\b(?:for|in|within|after)\s+(a|an|one|two|three|four|five|six|seven|ten|fourteen|\d{1,2})\s*(days?|weeks?)\b/.exec(
      t,
    );
  if (!match) return undefined;
  const count = COUNT[match[1]] ?? Number(match[1]);
  const days = match[2].startsWith("week") ? count * 7 : count;
  return days >= 1 && days <= 60 ? days : undefined;
}

/** When a check-in goes out: `days` from now, moved into his waking hours (three hours after he wakes) if it would fall at night. */
export function checkInTime(now: Date, days: number, routine: Routine): Date {
  const target = new Date(now.getTime() + days * DAY_MINUTES * MINUTE);
  const midnight = localMidnight(target);
  const minute = Math.round((target.getTime() - midnight) / MINUTE);
  const { wake, sleep } = minutesOf(routine);
  const morning = wake + 180;
  if (minute < wake + 60) return new Date(midnight + morning * MINUTE);
  if (minute > sleep - 60) return new Date(midnight + (DAY_MINUTES + morning) * MINUTE);
  return target;
}

/** At a check-in's time: send it if the task really sat untouched that long; otherwise wait until it has. */
export function checkInDue(input: { now: Date; updatedAt: Date; everyDays: number; routine: Routine }): { send: true } | { send: false; next: Date } {
  const quiet = input.now.getTime() - input.updatedAt.getTime();
  if (quiet >= input.everyDays * DAY_MINUTES * MINUTE - 60 * MINUTE) return { send: true };
  return { send: false, next: checkInTime(input.updatedAt, input.everyDays, input.routine) };
}

// ── What his routine looks like, in words ───────────────────────────────

/** One line per field, for /routine and for the model. */
export function routineLines(routine: Routine): string[] {
  const learned = Object.entries(routine.learned ?? {})
    .map(([kind, samples]) => {
      const minute = learnedMinute(samples);
      return minute === undefined ? undefined : `${kind} around ${clockText(minute)} (from ${samples.length} moves)`;
    })
    .filter(Boolean);
  return [
    `Awake: ${routine.wake}–${routine.sleep}`,
    `Teaching: ${routine.teaching ?? "not set"}`,
    `Content: ${routine.content ?? "not set"}`,
    `Coding: ${routine.coding ?? "not set"}`,
    `Workout: ${routine.workout ?? "not set"}`,
    `Free days: ${routine.free_days ?? "not set"}`,
    ...(learned.length ? [`Learned: ${learned.join("; ")}`] : []),
  ];
}

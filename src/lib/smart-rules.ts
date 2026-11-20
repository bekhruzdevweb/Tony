/**
 * Pure rules for phases b–e (21 Nov): bursts of messages, situation rules,
 * the Free Time list and its suggestions, the follow-up ladder, and the
 * notification budget. No database, no model; tested in tests/smart.test.ts.
 */
import { kindOf, type Kind } from "./routine-rules";
import { formatTime, hisDate, localDate, TIMEZONE } from "./time";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

// ── b) Bursts: messages within a minute are one request ────────────────

/** How long Tony waits after the last message before answering. */
export const BURST_QUIET_MS = 4_000;
/** Messages this close to the first one belong to the same request. */
export const BURST_WINDOW_MS = 60_000;

/** Messages waiting to be answered, oldest first, split into requests: each runs while messages keep coming within a minute of its first. */
export function groupBursts<T extends { received_at: string }>(rows: T[]): T[][] {
  const sorted = [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at));
  const groups: T[][] = [];
  for (const row of sorted) {
    const current = groups[groups.length - 1];
    if (current && new Date(row.received_at).getTime() - new Date(current[0].received_at).getTime() <= BURST_WINDOW_MS) current.push(row);
    else groups.push([row]);
  }
  return groups;
}

// ── b) Situation rules: "when I'm not motivated to work out, send me this video" ──

/** The kind of task a situation is about ("not motivated to work out" → workout). */
export function situationKind(situation: string): Kind | undefined {
  const t = situation.toLowerCase();
  if (/\b(work ?out|gym|exercise|training|run|running)\b/.test(t)) return "workout";
  if (/\b(study|studying|ielts|read|reading)\b/.test(t)) return "study";
  if (/\b(content|post|posting|reels?|film|filming|record)\b/.test(t)) return "content";
  if (/\b(code|coding|programming|app)\b/.test(t)) return "coding";
  return undefined;
}

/**
 * When a rule also fires on its own: "skip it for 3 days" in his words, or,
 * for a rule about his motivation for a kind of task, after 3 days without it.
 */
export function skipTrigger(situation: string): { kind: Kind; days: number } | undefined {
  const kind = situationKind(situation);
  if (!kind) return undefined;
  const t = situation.toLowerCase();
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, a: 1, one: 1 };
  const said = /\b(\d{1,2}|two|three|four|five|six|seven|a|one)\s*(days?|weeks?)\b/.exec(t);
  if (said) {
    const count = words[said[1]] ?? Number(said[1]);
    return { kind, days: said[2].startsWith("week") ? count * 7 : count };
  }
  if (/\b(motivat|lazy|don'?t want|do not want|skip|miss|tired|give up|quit)/.test(t)) return { kind, days: 3 };
  return undefined;
}

/** Feelings and moods that often stand for a situation he described in other words. */
const MOOD = /\b(tired|exhausted|lazy|bored|sad|down|stressed|unmotivated|not motivated|no motivation|don'?t (want|feel like)|do not (want|feel like)|can'?t be bothered|give up|quit|skip|skipping)\b/i;

/**
 * Rules his message may match ("I'm tired, don't want to work out" ↔ "when I'm
 * not motivated to work out"): the same task kind with a mood, or shared words.
 * A hint for the brain, which decides; never acted on alone.
 */
export function ruleHints<T extends { id: number; situation: string }>(text: string, rules: T[]): T[] {
  const t = text.toLowerCase();
  const stems = (value: string) => new Set((value.toLowerCase().match(/\p{L}{4,}/gu) ?? []).map((word) => word.slice(0, 5)));
  const his = stems(t);
  return rules.filter((rule) => {
    const kind = situationKind(rule.situation);
    if (kind && situationKind(t) === kind && MOOD.test(t)) return true;
    const shared = [...stems(rule.situation)].filter((stem) => his.has(stem) && !["when", "want", "send", "motiv"].includes(stem));
    return shared.length >= 2;
  });
}

/** "When I'm not motivated to work out, send me this video": a rule to keep, never a request to send it now. */
export const isRuleRequest = (text: string) => /^\s*(when(ever)?|if|every time|each time|in case)\s+(i\b|i'm|im\b|i am|i've|my\b|it'?s\b|it is|there'?s|the\b|we\b)[^.?!]{2,}?[,]?\s*(send|show|remind|tell|give|play|share)\b/i.test(text);

/** "Show my rules", "my rules", "list rules". */
export const asksForRules = (text: string) => /^\s*(show|list|see|what are)?\s*(me\s+)?(all\s+)?(my|the)\s+rules\??\s*$/i.test(text) || /^\s*rules\s*$/i.test(text);

// ── c) Free Time list ───────────────────────────────────────────────────

/** "In my free time", "someday", "when I'm free": the 🌙 Free Time list, no date. */
export const isFreeTimeRequest = (text: string) =>
  /\b(in (my )?(free|spare) time|free ?time list|some ?day|one day|when i'?m free|when i am free|when i (have|get|find) (some )?(free )?time|whenever i (have time|can|get (the |a )?chance)|no rush)\b/i.test(text);

/** "I'm free", "I'm bored", "what should I do now?": a suggestion from the list, now. */
export const saysFree = (text: string) =>
  /^\s*(ok(ay)?,?\s+)?(i'?m|i am|im)\s+(free|bored)(\s+(now|right now|at the moment))?\s*[.!]?\s*$/i.test(text) ||
  /^\s*(i have|i've got|ive got|got) (some )?free time( now)?\s*[.!]?\s*$/i.test(text) ||
  /^\s*(i have )?nothing to do( now)?\s*[.!]?\s*$/i.test(text) ||
  /^\s*what (should|can|could) i do( now| right now)?\s*\??\s*$/i.test(text);

export type FreeItem = { id: number; title: string; created_at: string; duration_minutes?: number | null; project?: string | null };
export type FreeStats = Record<string, { offered: number; accepted: number }>;

/** A part of the day, for learning when he likes free-time items. */
export const band = (hour: number) => (hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening");

/**
 * The free-time item to suggest now: one that fits the time he has, not
 * offered in the last two days, the kinds he accepts at this time of day
 * first, then the one waiting longest.
 */
export function pickFreeItem(items: FreeItem[], input: { minutesFree: number; hour: number; stats: FreeStats; offeredSince: Set<number> }): FreeItem | undefined {
  const fits = items.filter((item) => !input.offeredSince.has(item.id) && (item.duration_minutes ?? 30) <= input.minutesFree);
  const rate = (item: FreeItem) => {
    const key = `${kindOf(item.title, item.project)}:${band(input.hour)}`;
    const seen = input.stats[key] ?? { offered: 0, accepted: 0 };
    return (seen.accepted + 1) / (seen.offered + 2);
  };
  return fits.sort((a, b) => rate(b) - rate(a) || a.created_at.localeCompare(b.created_at))[0];
}

/** "You're free until 18:00. Want to finally watch **X**? It's been waiting 9 days." */
export function freeTimeText(item: FreeItem, until: Date | undefined, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(item.created_at).getTime()) / DAY_MS);
  const free = until ? `You're free until **${formatTime(until)}**.` : "You've got a free stretch.";
  const verb = /^(watch|read|listen to|listen|study|learn)\b:?\s*/i.exec(item.title);
  const what = verb ? `${verb[1].toLowerCase()} **${item.title.slice(verb[0].length).trim()}**` : `get to **${item.title}**`;
  const waiting = days >= 2 ? ` It's been waiting ${days} days.` : "";
  return `${free} Want to finally ${what}?${waiting}`;
}

// ── d) Follow-up ladder ─────────────────────────────────────────────────

export type OpenTask = { id: number; title: string; due_at: string | null; status: string; kind?: string | null; duration_minutes?: number | null; updated_at: string; free_time?: boolean | null };

/** Whole days a task has slipped, by the day he lives: due yesterday is 1. */
export function slippedDays(task: Pick<OpenTask, "due_at">, now: Date): number {
  if (!task.due_at) return 0;
  const start = (date: string) => new Date(`${date}T00:00:00+05:00`).getTime();
  return Math.round((start(hisDate(now, TIMEZONE)) - start(localDate(new Date(task.due_at)))) / DAY_MS);
}

/** Missed today: due today, at least two hours ago, still open, not followed up yet today. */
export function missedToday(tasks: OpenTask[], now: Date, followedUp: Set<number>): OpenTask[] {
  return tasks
    .filter((task) => task.due_at && task.kind !== "prayer" && task.status !== "in_progress" && !followedUp.has(task.id))
    .filter((task) => slippedDays(task, now) === 0 && now.getTime() - new Date(task.due_at!).getTime() >= 2 * 60 * MINUTE)
    .sort((a, b) => a.due_at!.localeCompare(b.due_at!));
}

/** Still open from earlier days, oldest first: the top of the morning brief. */
export function stillOpen(tasks: OpenTask[], now: Date): OpenTask[] {
  return tasks.filter((task) => task.due_at && task.kind !== "prayer" && slippedDays(task, now) >= 1).sort((a, b) => a.due_at!.localeCompare(b.due_at!));
}

/** Inbox items untouched for 7 days or more, for Sunday evening's review (the Free Time list is not reviewed). */
export function staleInbox(tasks: OpenTask[], now: Date): OpenTask[] {
  return tasks
    .filter((task) => task.status === "inbox" && !task.due_at && !task.free_time && task.kind !== "prayer" && now.getTime() - new Date(task.updated_at).getTime() >= 7 * DAY_MS)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

/** How a task left open reads in a follow-up: "Call the bank · was 10:00", "Post stories · slipped 3 days". */
export function openLine(task: OpenTask, now: Date): string {
  const days = slippedDays(task, now);
  if (days <= 0) return `**${task.title}** · was ${formatTime(new Date(task.due_at!))}`;
  if (days >= 3) return `**${task.title}** · slipped ${days} days`;
  return `**${task.title}** · ${days === 1 ? "since yesterday" : `${days} days`}`;
}

// ── e) Notification budget ──────────────────────────────────────────────

/** Unasked messages a day (besides prayers, reminders he set and check-ins he asked for). */
export const NOTIFY_LIMIT = 8;
/** Reminders this close together go out as one message. */
export const MERGE_MS = 15 * MINUTE;

/** First reminders that fall within 15 minutes of the earliest due one: sent as one message. */
export function mergeable<T extends { fire_at: string }>(due: T, upcoming: T[]): T[] {
  const first = new Date(due.fire_at).getTime();
  return upcoming.filter((other) => other !== due && new Date(other.fire_at).getTime() - first <= MERGE_MS && new Date(other.fire_at).getTime() >= first - MERGE_MS);
}

/** After downtime: the gap since the last clean tick, if long enough to call it downtime. */
export function downtime(lastTick: string | null, now: Date): { from: Date; minutes: number } | undefined {
  if (!lastTick) return undefined;
  const from = new Date(lastTick);
  const minutes = Math.round((now.getTime() - from.getTime()) / MINUTE);
  return minutes >= 10 ? { from, minutes } : undefined;
}

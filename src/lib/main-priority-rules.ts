/**
 * His main priority (22 Nov, his idea), the pure rules: when Tony chases it,
 * and what he says. No database, no model.
 *
 * - One thing at a time (it may be the sessions of one plan, one a day): the
 *   one Tony chases today is the earliest of them due today.
 * - From 30 minutes after its time, if it is not started or done: a nudge
 *   every 30 minutes; after two he did not answer, every hour. Never in
 *   quiet hours (the tick skips them), at most 8 a day, the last one saying so.
 * - Started: quiet for as long as it takes (an hour if it has no length),
 *   then "Done?".
 * - A reminder still to come (he said "in 1 hour" or moved it) waits for it.
 */

export const NUDGE_CAP = 8;
const MINUTE = 60_000;
/** A main priority with no time of its own, or one left from an earlier day, is chased from 10:00. */
export const UNTIMED_HOUR = 10;

export type ChaseInput = {
  now: Date;
  /** Its time today (10:00 for one with no time, or left from an earlier day). */
  due: Date;
  status: string;
  /** In progress since (when he started it). */
  startedAt?: Date;
  /** Its length in minutes. */
  minutes?: number | null;
  /** A reminder about it still to come. */
  nextReminderAt?: Date;
  /** The last reminder or nudge about it that went out. */
  lastSentAt?: Date;
  /** Nudges sent today (for any main priority). */
  nudgesToday: number;
  /** Nudges since he last touched it (a tap, a change). */
  unanswered: number;
};

export type ChaseStep = { kind: "nudge" | "check" | "last"; n: number };

export function chaseStep(input: ChaseInput): ChaseStep | undefined {
  const { now } = input;
  if (!["todo", "inbox", "in_progress"].includes(input.status)) return undefined;
  if (input.nextReminderAt && input.nextReminderAt.getTime() > now.getTime()) return undefined;
  if (now.getTime() < input.due.getTime() + 30 * MINUTE) return undefined;
  if (input.nudgesToday >= NUDGE_CAP) return undefined;
  const started = input.status === "in_progress";
  if (started && input.startedAt && now.getTime() < input.startedAt.getTime() + (input.minutes || 60) * MINUTE) return undefined;
  const interval = (input.unanswered >= 2 ? 60 : 30) * MINUTE;
  if (input.lastSentAt && now.getTime() - input.lastSentAt.getTime() < interval) return undefined;
  const n = input.nudgesToday + 1;
  return { kind: started ? "check" : n >= NUDGE_CAP ? "last" : "nudge", n };
}

const elapsed = (from: Date, to: Date) => {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${rest} min`;
};

/**
 * What Tony says, in markdown: plain and short, firmer as it goes on, never guilt.
 * `at` is its time ("09:00"), undefined when it has none.
 */
export function chaseText(step: ChaseStep, title: string, due: Date, now: Date, at?: string): string {
  const name = `**${title}**`;
  if (step.kind === "check") return `⭐ Done with ${name}, sir?`;
  if (step.kind === "last") return `⭐ I'll stop for today, sir. ${name} stays your main priority; I'll pick it up again tomorrow.`;
  if (step.n === 1) return at ? `⭐ ${name} is still waiting, sir: your main priority, set for **${at}**.` : `⭐ ${name} is still waiting, sir: your main priority for today.`;
  if (step.n === 2) return `⭐ Still not started: ${name}${at ? ` (${at})` : ""}. Now, or tell me when.`;
  return at ? `⭐ ${name}: ${elapsed(due, now)} since **${at}**. Shall we start?` : `⭐ ${name} is still not started, sir. Shall we start?`;
}

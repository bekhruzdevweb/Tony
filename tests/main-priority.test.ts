/**
 * His main priority (22 Nov, his idea): chased until it is done. The rules:
 * from 30 minutes after its time, every 30 minutes, hourly once two went
 * unanswered, at most 8 a day (the last says so); started, quiet for its
 * length, then "Done?"; a reminder still to come is waited for.
 */
import { describe, expect, it } from "vitest";
import { chaseStep, chaseText, NUDGE_CAP, waitedReminder, type ChaseInput } from "../src/lib/main-priority-rules";

const at = (local: string) => new Date(`${local}:00+05:00`);
const due = at("2026-11-23T09:00");
const base = (now: string, extra: Partial<ChaseInput> = {}): ChaseInput => ({ now: at(now), due, status: "todo", nudgesToday: 0, unanswered: 0, ...extra });

describe("when Tony chases it", () => {
  it("not before half an hour after its time", () => {
    expect(chaseStep(base("2026-11-23T09:29"))).toBeUndefined();
    expect(chaseStep(base("2026-11-23T09:30"))).toEqual({ kind: "nudge", n: 1 });
  });

  it("every 30 minutes while he answers; hourly once two went unanswered", () => {
    const sent = (time: string) => ({ lastSentAt: at(`2026-11-23T${time}`) });
    expect(chaseStep(base("2026-11-23T09:59", { nudgesToday: 1, unanswered: 1, ...sent("09:30") }))).toBeUndefined();
    expect(chaseStep(base("2026-11-23T10:00", { nudgesToday: 1, unanswered: 1, ...sent("09:30") }))).toEqual({ kind: "nudge", n: 2 });
    expect(chaseStep(base("2026-11-23T10:30", { nudgesToday: 2, unanswered: 2, ...sent("10:00") }))).toBeUndefined();
    expect(chaseStep(base("2026-11-23T11:00", { nudgesToday: 2, unanswered: 2, ...sent("10:00") }))).toEqual({ kind: "nudge", n: 3 });
  });

  it("at most 8 a day, the last one saying it stops for today", () => {
    expect(chaseStep(base("2026-11-23T18:00", { nudgesToday: NUDGE_CAP - 1, unanswered: 7, lastSentAt: at("2026-11-23T16:00") }))).toEqual({ kind: "last", n: NUDGE_CAP });
    expect(chaseStep(base("2026-11-23T19:00", { nudgesToday: NUDGE_CAP, unanswered: 8, lastSentAt: at("2026-11-23T17:00") }))).toBeUndefined();
  });

  it("started: quiet for its length (an hour without one), then 'Done?'", () => {
    const started = { status: "in_progress", startedAt: at("2026-11-23T09:10"), minutes: 240 };
    expect(chaseStep(base("2026-11-23T13:09", started))).toBeUndefined();
    expect(chaseStep(base("2026-11-23T13:10", started))).toEqual({ kind: "check", n: 1 });
    expect(chaseStep(base("2026-11-23T10:10", { ...started, minutes: null }))).toEqual({ kind: "check", n: 1 });
  });

  it("a reminder still to come ('in 1 hour', or moved) is waited for; a finished task is left alone", () => {
    expect(chaseStep(base("2026-11-23T10:00", { nextReminderAt: at("2026-11-23T10:30") }))).toBeUndefined();
    expect(chaseStep(base("2026-11-23T10:00", { status: "done" }))).toBeUndefined();
  });
});

describe("which reminder the chase waits for", () => {
  // 23 Nov 04:30: "yes keep it as the main task of the day" on "Make my own IELTS plan", a task with no
  // time (its one quiet check at 20:00). The chase waited for that check: the first nudge came at 20:16.
  const plan = { due_at: at("2026-11-23T20:00").toISOString(), anytime: true };
  const check = { kind: "due", state: "scheduled", fire_at: at("2026-11-23T20:00").toISOString() };

  it("a main priority with no time is chased from 10:30; its own 20:00 check is not waited for", () => {
    expect(waitedReminder([check], plan, false)).toBeUndefined();
    const fromTen = at("2026-11-23T10:00");
    expect(chaseStep({ now: at("2026-11-23T10:30"), due: fromTen, status: "todo", nudgesToday: 0, unanswered: 0, nextReminderAt: waitedReminder([check], plan, false) })).toEqual({ kind: "nudge", n: 1 });
  });

  it("'in 1 hour' on it is still waited for", () => {
    const snoozed = { kind: "due", state: "scheduled", fire_at: at("2026-11-23T11:30").toISOString() };
    expect(waitedReminder([check, snoozed], plan, false)).toEqual(at("2026-11-23T11:30"));
  });

  it("a main priority with a time of its own waits for its reminder as before", () => {
    const timed = { due_at: at("2026-11-23T15:00").toISOString(), anytime: false };
    const own = { kind: "due", state: "scheduled", fire_at: at("2026-11-23T15:00").toISOString() };
    expect(waitedReminder([own], timed, true)).toEqual(at("2026-11-23T15:00"));
    expect(waitedReminder([{ ...own, state: "sent" }], timed, true)).toBeUndefined();
  });
});

describe("what Tony says", () => {
  const now = at("2026-11-23T11:30");
  it("plain, firmer as it goes, never guilt", () => {
    const title = "IELTS: Writing Task 2 (learn) + Speaking Part 3";
    expect(chaseText({ kind: "nudge", n: 1 }, title, due, now, "09:00")).toBe(`⭐ **${title}** is still waiting, sir: your main priority, set for **09:00**.`);
    expect(chaseText({ kind: "nudge", n: 2 }, title, due, now, "09:00")).toBe(`⭐ Still not started: **${title}** (09:00). Now, or tell me when.`);
    expect(chaseText({ kind: "nudge", n: 3 }, title, due, now, "09:00")).toBe(`⭐ **${title}**: 2 h 30 min since **09:00**. Shall we start?`);
    expect(chaseText({ kind: "check", n: 4 }, title, due, now, "09:00")).toBe(`⭐ Done with **${title}**, sir?`);
    expect(chaseText({ kind: "last", n: 8 }, title, due, now, "09:00")).toBe(`⭐ I'll stop for today, sir. **${title}** stays your main priority; I'll pick it up again tomorrow.`);
    expect(chaseText({ kind: "nudge", n: 1 }, "Finish the landing page", due, now)).toBe("⭐ **Finish the landing page** is still waiting, sir: your main priority for today.");
  });
});

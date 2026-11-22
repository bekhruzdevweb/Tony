/**
 * Regression tests for the cases of 20 November 2026 (Tashkent time).
 * Each test names the real message that went wrong.
 */
import { describe, expect, it } from "vitest";
import {
  allClashes,
  asksToSave,
  clashSentence,
  clashesWith,
  confirmationFor,
  decideReminder,
  findLink,
  isDuplicateReminder,
  latestMessage,
  needsDeepModel,
  nextFreeSlot,
  recentReminderNote,
  titleFrom,
  type TimedTask,
} from "../src/lib/brain/checks";
import { splitToday } from "../src/lib/today";
import type { Task } from "../src/lib/tasks";

const at = (local: string) => new Date(`${local}:00+05:00`);
const NOW = at("2026-11-20T17:31");

describe('17:31 "tomorrow remind me to call the barber at 8.30" (task 21 was at 07:00)', () => {
  it("moves the task to 08:30 instead of adding a heads-up and leaving it at 07:00", () => {
    expect(decideReminder(at("2026-11-21T07:00"), at("2026-11-21T08:30"))).toBe("move");
  });
  it("adds a heads-up only when the time is before the task", () => {
    expect(decideReminder(at("2026-11-21T08:30"), at("2026-11-21T07:30"))).toBe("extra");
  });
  it("adds nothing when a reminder at that time already exists", () => {
    expect(decideReminder(at("2026-11-21T08:30"), at("2026-11-21T08:30"))).toBe("same");
    expect(isDuplicateReminder([{ fire_at: at("2026-11-21T07:30").toISOString() }], at("2026-11-21T07:30"))).toBe(true);
    expect(isDuplicateReminder([{ fire_at: at("2026-11-21T07:30").toISOString() }], at("2026-11-21T07:45"))).toBe(false);
  });
  it("confirms the time that is really stored, not the one the model announced", () => {
    // Read back after the change: if the task had stayed at 07:00, the reply says 07:00.
    const reply = confirmationFor([{ tool: "set_reminder", title: "Call the barber", status: "todo", due_at: at("2026-11-21T07:00").toISOString() }], NOW);
    expect(reply).toContain("07:00");
    expect(reply).not.toContain("08:30");
  });
});

describe('17:31 "Can you remind this one after 20 minutes? And also … barber at 8.30" (two requests)', () => {
  it('ties "this one" to the reminder sent a minute earlier', () => {
    const note = recentReminderNote([{ task_id: 30, title: "Prepare for the lesson", sent_at: at("2026-11-20T17:30").toISOString() }], NOW);
    expect(note).toContain('"Prepare for the lesson"');
    expect(note).toContain("#30");
  });
  it("ignores reminders older than 15 minutes", () => {
    expect(recentReminderNote([{ task_id: 30, title: "Old", sent_at: at("2026-11-20T17:00").toISOString() }], NOW)).toBeUndefined();
  });
  it("lists every change in the reply", () => {
    const reply = confirmationFor(
      [
        { tool: "update_task", title: "Prepare for the lesson", status: "todo", due_at: at("2026-11-20T17:51").toISOString() },
        { tool: "update_task", title: "Call the barber", status: "todo", due_at: at("2026-11-21T08:30").toISOString() },
      ],
      NOW,
    );
    expect(reply).toContain("Prepare for the lesson");
    expect(reply).toContain("Call the barber");
    // Weekday and date in every confirmation.
    expect(reply).toMatch(/today, Fri 20 Nov, \*\*17:51\*\*/);
    expect(reply).toMatch(/tomorrow, Sat 21 Nov, \*\*08:30\*\*/);
  });
  it("sends a message with several requests to the larger model", () => {
    expect(needsDeepModel("Can you remind this one after 20 minutes? And also, tomorrow remind me to call the barber at 8.30 a.m.")).toBe(true);
    expect(needsDeepModel("thanks Tony")).toBe(false);
  });
});

describe('17:32 "Also remind me to prepare for my lesson after half an hour" (answered about the barber)', () => {
  it("marks the newest message as the one to handle, and only it", () => {
    const turn = latestMessage("Also remind me to prepare for my lesson after half an hour.");
    expect(turn).toMatch(/latest message/i);
    expect(turn).toMatch(/nothing from earlier messages/i);
    expect(turn).toContain("prepare for my lesson");
  });
  it("goes to the larger model (a timed request after an 'also')", () => {
    expect(needsDeepModel("Also remind me to prepare for my lesson after half an hour.")).toBe(true);
  });
});

describe('"save this with the link" ("I haven\'t saved anything")', () => {
  it("is recognised as a request to save", () => {
    expect(asksToSave("save this with the link")).toBe(true);
    expect(asksToSave("Save it")).toBe(true);
    expect(asksToSave("what did I save yesterday?")).toBe(false);
  });
  it("finds the link in his words, or in the last thing he shared", () => {
    expect(findLink("save this https://example.com/a).")).toBe("https://example.com/a");
    expect(findLink("save this with the link", "Post forwarded from X\nhttps://www.instagram.com/reel/DfoBspQhNjO/?fqnt=1")).toBe("https://www.instagram.com/reel/DfoBspQhNjO/?fqnt=1");
  });
  it("gives the bookmark a proper title, not just the site's name", () => {
    expect(titleFrom('<meta property="og:title" content="Five ways to teach grammar">', "https://blog.example/x")).toBe("Five ways to teach grammar");
    expect(titleFrom("<title>Instagram</title>", "https://www.instagram.com/reel/DfoBspQhNjO/")).toBe("Instagram reel");
  });
});

const task = (id: number, title: string, local: string | null, extra: Partial<TimedTask> = {}): TimedTask => ({ id, title, due_at: local ? at(local).toISOString() : null, status: "todo", ...extra });

describe("Clash detection", () => {
  const workout = task(1, "Workout", "2026-11-20T18:00");
  const reading = task(2, "Reading", "2026-11-20T18:00");
  it("warns when two tasks share a time", () => {
    expect(clashesWith(reading, [workout]).map((t) => t.title)).toEqual(["Workout"]);
    expect(clashSentence(workout, reading)).toBe("Workout and Reading are both at 18:00");
  });
  it("counts tasks within 30 minutes, or overlapping by their durations", () => {
    expect(clashesWith(task(3, "Call", "2026-11-20T18:25"), [workout])).toHaveLength(1);
    expect(clashesWith(task(3, "Call", "2026-11-20T18:45"), [workout])).toHaveLength(0);
    expect(clashesWith(task(3, "Call", "2026-11-20T18:45"), [{ ...workout, duration_minutes: 60 }])).toHaveLength(1);
  });
  it("a short call inside a long block, after it began, is a break, not a clash (22 Nov 12:52, the barber at 16:00)", () => {
    const app = task(4, "Update fitness app", "2026-11-22T14:45", { duration_minutes: 120 });
    const barber = task(5, "Call barber", "2026-11-22T16:00", { duration_minutes: 10 });
    expect(clashesWith(barber, [app])).toHaveLength(0);
    expect(clashesWith(app, [barber])).toHaveLength(0);
    // At the block's own start it is still a clash; and a 30-minute task inside it is too.
    expect(clashesWith(task(6, "Call barber", "2026-11-22T14:45", { duration_minutes: 10 }), [app])).toHaveLength(1);
    expect(clashesWith(task(7, "Post stories", "2026-11-22T16:00", { duration_minutes: 30 }), [app])).toHaveLength(1);
  });
  it("never counts prayers, or done tasks", () => {
    expect(clashesWith(reading, [task(9, "Maghrib", "2026-11-20T18:00", { kind: "prayer" })])).toHaveLength(0);
    expect(clashesWith(reading, [task(9, "Old", "2026-11-20T18:00", { status: "done" })])).toHaveLength(0);
  });
  it("suggests the next free hour", () => {
    const free = nextFreeSlot(reading, [workout], at("2026-11-20T23:00"));
    expect(free?.toISOString()).toBe(at("2026-11-20T19:00").toISOString());
  });
  it("lists each clashing pair once for the brief and /plan", () => {
    expect(allClashes([workout, reading, task(3, "Calls", "2026-11-20T10:00")])).toHaveLength(1);
  });
});

describe("Prayers are not tasks", () => {
  const base = { notes: null, project_id: null, priority: 4, persistent: false, persistent_schedule: null, repeat_rule: null, created_at: "", updated_at: "", completed_at: null } as const;
  const row = (id: number, title: string, local: string, kind: string | null): Task => ({ ...base, id, title, status: "todo", due_at: at(local).toISOString(), kind });
  it("are left out of the open and overdue counts", () => {
    const split = splitToday([row(1, "Fajr", "2026-11-20T06:28", "prayer"), row(2, "Maghrib", "2026-11-20T17:38", "prayer"), row(3, "Workout", "2026-11-20T18:00", null)], NOW);
    expect(split.total).toBe(1);
    expect([...split.carried, ...split.timed].map((t) => t.title)).toEqual(["Workout"]);
  });
});

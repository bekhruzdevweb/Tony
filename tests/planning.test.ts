/**
 * Regression tests for planning and free times (20 November 2026, Tashkent):
 * /plan late in the day, several tasks without times, links that got a date,
 * and buttons offering times that were not free.
 */
import { describe, expect, it } from "vitest";
import { freeOptions, givesTime, isFreeAt, isLinkTask, namesDay, planDay, type TimedTask } from "../src/lib/brain/checks";
import { freeMinutesLeft, nextFree, windowOf } from "../src/lib/planner";

const at = (local: string) => new Date(`${local}:00+05:00`);
const task = (id: number, title: string, local: string, extra: Partial<TimedTask> = {}): TimedTask => ({ id, title, due_at: at(local).toISOString(), status: "todo", ...extra });

describe("/plan when today is nearly over", () => {
  it("plans tomorrow after 20:00", () => {
    expect(planDay(at("2026-11-20T21:00"), 60)).toBe("tomorrow");
    expect(planDay(at("2026-11-20T20:00"), 300)).toBe("tomorrow");
  });
  it("plans tomorrow from 17:00 with under an hour free; earlier, today's few free hours are still today's", () => {
    expect(planDay(at("2026-11-20T18:30"), 45)).toBe("tomorrow");
    expect(planDay(at("2026-11-20T16:15"), 45)).toBe("today");
  });
  it("plans today while there is room", () => {
    expect(planDay(at("2026-11-20T15:00"), 240)).toBe("today");
  });

  // 22 Nov 16:15: every task counted as a whole hour, three at 20:15 as three hours, and the prayers too:
  // "0 free minutes", so "Today is nearly over, sir — here's tomorrow." With five hours still free.
  it("counts what is really booked: each task for its length, tasks at the same time once, prayers ±15 minutes", () => {
    const now = at("2026-11-22T16:15");
    const booked = [
      { title: "Build a new diet plan", due_at: at("2026-11-22T16:45").toISOString(), duration_minutes: 45 },
      { title: "Maghrib", kind: "prayer", due_at: at("2026-11-22T17:37").toISOString() },
      { title: "Add my workout days to Tony", due_at: at("2026-11-22T17:45").toISOString(), duration_minutes: 15 },
      { title: "Launch beginner and elementary course", due_at: at("2026-11-22T18:00").toISOString(), duration_minutes: 60 },
      { title: "Post stories in this format", due_at: at("2026-11-22T18:00").toISOString(), duration_minutes: 30 },
      { title: "Isha", kind: "prayer", due_at: at("2026-11-22T18:56").toISOString() },
      { title: "Posting stories on Instagram", due_at: at("2026-11-22T20:15").toISOString() },
      { title: "Instagram reel (saved link)", due_at: at("2026-11-22T20:15").toISOString() },
      { title: "Start IELTS exam preparation", due_at: at("2026-11-22T20:15").toISOString(), duration_minutes: 60 },
    ];
    const free = freeMinutesLeft(now, windowOf(now, "23:00"), booked);
    // 16:30–22:00 (Tony plans until an hour before quiet hours) is 330 minutes; booked: 16:45–19:11 (the diet
    // plan, Maghrib, the workout days, the course launch and the stories, Isha) and 20:15–21:15 (the three at
    // 20:15, counted once). Left: 15 + 64 + 45 = 124 minutes.
    expect(free).toBe(124);
    expect(planDay(now, free)).toBe("today");
  });

  it("knows when he names the day: 'for today', 'today isn't over', '22 november', '22.11'", () => {
    for (const words of ["Can you assign me all my tasks for today?", "Today isn't over, girl.", "i asked for today", "i meant 22 november", "plan nov 22", "22.11 please", "the rest of the day"]) {
      expect(namesDay(words, "2026-11-22")).toBe(true);
    }
    for (const words of ["plan my day", "what about 23 november", "plan the week"]) expect(namesDay(words, "2026-11-22")).toBe(false);
  });
});

describe('Several tasks at once ("presentation and a zoom tutorial")', () => {
  // The planner's own slot finder, on tomorrow's window, around "Posting reel on Instagram" at 15:00.
  const tomorrow = at("2026-11-21T12:00");
  const windows = [windowOf(tomorrow, "23:00")];
  const now = at("2026-11-20T21:00");
  it("gives each task its own slot, clear of fixed tasks and of each other", () => {
    const busy = [{ at: at("2026-11-21T15:00"), title: "Posting reel on Instagram" }];
    const first = nextFree(at("2026-11-21T14:30"), busy, windows, now)!;
    busy.push({ at: first, title: "Presentation" });
    const second = nextFree(at("2026-11-21T14:30"), busy, windows, now)!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.getTime()).not.toBe(second.getTime());
    for (const slot of [first, second]) expect(Math.abs(slot.getTime() - at("2026-11-21T15:00").getTime())).toBeGreaterThanOrEqual(60 * 60_000);
    expect(Math.abs(first.getTime() - second.getTime())).toBeGreaterThanOrEqual(60 * 60_000);
  });
});

describe('The reel link that was set to 15:00 tomorrow', () => {
  it("is a link task", () => {
    expect(isLinkTask("Read: instagram.com", "https://www.instagram.com/reel/DfoBspQhNjO/")).toBe(true);
    expect(isLinkTask("Posting reel on Instagram", null)).toBe(false);
  });
  it("gets a date only when his words give one", () => {
    expect(givesTime("save this with the link")).toBe(false);
    expect(givesTime("save this and remind me tomorrow")).toBe(true);
    expect(givesTime("at 3 pm")).toBe(true);
    expect(givesTime("in 20 minutes")).toBe(true);
  });
});

describe("Only free times on buttons", () => {
  const tasks = [task(1, "Posting reel on Instagram", "2026-11-21T15:00"), task(2, "Maghrib", "2026-11-21T17:37", { kind: "prayer" })];
  const now = at("2026-11-20T21:00");
  it("knows a taken time from a free one", () => {
    expect(isFreeAt(at("2026-11-21T15:00"), tasks)).toBe(false);
    expect(isFreeAt(at("2026-11-21T15:20"), tasks)).toBe(false);
    expect(isFreeAt(at("2026-11-21T16:00"), tasks)).toBe(true);
    // Prayers do not block a time.
    expect(isFreeAt(at("2026-11-21T17:37"), tasks)).toBe(true);
  });
  it("drops question options whose time is taken", () => {
    expect(freeOptions(["Tomorrow 15:00", "Tomorrow 16:00", "Leave it"], tasks, now)).toEqual(["Tomorrow 16:00", "Leave it"]);
  });
});

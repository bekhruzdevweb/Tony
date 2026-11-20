/**
 * Regression tests for planning and free times (20 November 2026, Tashkent):
 * /plan late in the day, several tasks without times, links that got a date,
 * and buttons offering times that were not free.
 */
import { describe, expect, it } from "vitest";
import { freeOptions, givesTime, isFreeAt, isLinkTask, planDay, type TimedTask } from "../src/lib/brain/checks";
import { nextFree, windowOf } from "../src/lib/planner";

const at = (local: string) => new Date(`${local}:00+05:00`);
const task = (id: number, title: string, local: string, extra: Partial<TimedTask> = {}): TimedTask => ({ id, title, due_at: at(local).toISOString(), status: "todo", ...extra });

describe("/plan when today is nearly over", () => {
  it("plans tomorrow after 20:00", () => {
    expect(planDay(at("2026-11-20T21:00"), 60)).toBe("tomorrow");
    expect(planDay(at("2026-11-20T20:00"), 300)).toBe("tomorrow");
  });
  it("plans tomorrow with under two free hours left", () => {
    expect(planDay(at("2026-11-20T18:30"), 60)).toBe("tomorrow");
  });
  it("plans today while there is room", () => {
    expect(planDay(at("2026-11-20T15:00"), 240)).toBe("today");
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

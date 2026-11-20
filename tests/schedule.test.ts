/**
 * Smart auto-scheduling: durations, free time, prayers, quiet hours,
 * deep work in the morning and light tasks later.
 */
import { describe, expect, it } from "vitest";
import { busyIntervals, dayFromText, dayWindow, estimateMinutes, isDeep, placeAll } from "../src/lib/schedule";

const at = (local: string) => new Date(`${local}:00+05:00`);
const hhmm = (date: Date) => new Date(date.getTime() + 5 * 60 * 60_000).toISOString().slice(11, 16);
const NOW = at("2026-11-20T21:00");
const TOMORROW = dayWindow(at("2026-11-21T12:00"), "23:00", "07:00");

describe("Durations", () => {
  it("guesses a length from the title when none is given", () => {
    expect(estimateMinutes("Call the barber")).toBe(15);
    expect(estimateMinutes("Presentation")).toBe(60);
    expect(estimateMinutes("Film the grammar series")).toBe(90);
    expect(estimateMinutes("Something else")).toBe(30);
  });
  it("tells deep work from light", () => {
    expect(isDeep("Presentation", 60, 4)).toBe(true);
    expect(isDeep("Call the barber", 15, 4)).toBe(false);
  });
});

describe("Free slots", () => {
  const existing = [
    { due_at: at("2026-11-21T15:00").toISOString(), duration_minutes: 60 }, // Posting reel on Instagram
    { due_at: at("2026-11-21T18:00").toISOString(), duration_minutes: 45 }, // Workout
    { due_at: at("2026-11-21T12:43").toISOString(), kind: "prayer" }, // Dhuhr
    { due_at: at("2026-11-21T15:52").toISOString(), kind: "prayer" }, // Asr
  ];
  const busy = busyIntervals(existing);

  it("keeps to 07:00–23:00", () => {
    expect(hhmm(TOMORROW.start)).toBe("07:00");
    expect(hhmm(TOMORROW.end)).toBe("23:00");
  });

  it("puts deep work in the morning and light tasks in the afternoon, clear of tasks and prayers", () => {
    const { placed, left } = placeAll(
      [
        { id: 1, title: "Presentation", minutes: 60, priority: 4, deep: true },
        { id: 2, title: "Call the barber", minutes: 15, priority: 4, deep: false },
      ],
      busy,
      [TOMORROW],
      NOW,
    );
    expect(left).toEqual([]);
    const time = Object.fromEntries(placed.map((p) => [p.id, hhmm(p.at)]));
    expect(time[1]).toBe("07:00");
    expect(time[2] >= "13:00").toBe(true);
    for (const p of placed) {
      const start = p.at.getTime();
      for (const b of busy) expect(start >= b.end || start + 15 * 60_000 <= b.start).toBe(true);
    }
  });

  it("never proposes two tasks at the same time", () => {
    const { placed } = placeAll(
      [1, 2, 3].map((id) => ({ id, title: `Deep ${id}`, minutes: 60, priority: 4, deep: true })),
      busy,
      [TOMORROW],
      NOW,
    );
    const starts = placed.map((p) => p.at.getTime()).sort();
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(70 * 60_000);
  });

  it("puts the most important first", () => {
    const { placed } = placeAll(
      [
        { id: 1, title: "Later", minutes: 60, priority: 4, deep: true },
        { id: 2, title: "Urgent", minutes: 60, priority: 1, deep: true },
      ],
      busy,
      [TOMORROW],
      NOW,
    );
    expect(placed[0].id).toBe(2);
  });

  it("leaves out what does not fit", () => {
    const tight = { start: at("2026-11-21T07:00"), end: at("2026-11-21T07:30") };
    expect(placeAll([{ id: 1, title: "Long", minutes: 60, priority: 4, deep: true }], [], [tight], NOW).left).toEqual([1]);
  });
});

describe("The day he named", () => {
  it("reads today, tomorrow and weekdays", () => {
    expect(hhmm(dayFromText("tomorrow I need to do a presentation", NOW)!)).toBe("21:00");
    expect(dayFromText("tomorrow I need to do a presentation", NOW)!.toISOString().slice(0, 10)).toBe("2026-11-21");
    expect(dayFromText("on Monday", NOW)!.toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(dayFromText("a presentation and a zoom tutorial", NOW)).toBeUndefined();
  });
});

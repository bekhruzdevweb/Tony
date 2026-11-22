/**
 * Phase H (22 Nov): habits he chose, tags, and the words Tony says about a
 * habit's run. The pure rules; the end-to-end paths are in evals/phases.
 */
import { describe, expect, it } from "vitest";
import { streakLine, weekMarks, type HabitStats } from "../src/lib/habits";
import { hashtags, normalTag, normalTags, prefixTag, tagsFor, tagText } from "../src/lib/tags";
import type { Task } from "../src/lib/tasks";

describe("tags: his themes, lower case, without the #", () => {
  it("reads hashtags from his words, never a number or a part of a word", () => {
    expect(hashtags("film the grammar reel #content #IELTS and #5 tomorrow")).toEqual(["content", "ielts"]);
    expect(hashtags("email me@site.com#top")).toEqual([]);
  });
  it("a titled series is its own tag", () => {
    expect(prefixTag("IELTS: Reading + Listening (learn)")).toBe("ielts");
    expect(prefixTag("Workout: Legs A (standing + thighs)")).toBe("workout");
    expect(prefixTag("Shop list: outfit photos")).toBeUndefined();
    expect(prefixTag("Call barber")).toBeUndefined();
  });
  it("a new task's tags: asked for, his own, its series; at most six, no repeats", () => {
    expect(tagsFor("IELTS: Sunday review", ["#Study"], "add it #ielts")).toEqual(["study", "ielts"]);
    expect(normalTags(["a1", "b2", "c3", "d4", "e5", "f6", "g7"])).toHaveLength(6);
    expect(normalTag("##Content ")).toBe("content");
    expect(normalTag("2026")).toBeUndefined();
    expect(tagText(["content", "ielts"])).toBe("#content #ielts");
  });
});

const habit = (extra: Partial<HabitStats>): HabitStats => ({
  task: { id: 1, title: "Reading", repeat_rule: "daily", habit: true } as Task,
  streak: 0,
  best: 0,
  missedRun: 0,
  missesThisWeek: 0,
  dueToday: true,
  doneToday: false,
  daysTracked: 1,
  recent: [],
  week: [],
  ...extra,
});

describe("what Tony says about a habit's run: real numbers, warm, never shaming", () => {
  it("a new habit, a run, a slip, and the moment it is ticked", () => {
    expect(streakLine(habit({}))).toBe("🌱 Day one of this habit");
    expect(streakLine(habit({ streak: 3, best: 5, lastDone: "2026-11-21", daysSinceLast: 1 }))).toBe("🔥 3 days in a row: keep it going");
    expect(streakLine(habit({ missedRun: 2, lastDone: "2026-11-19", daysSinceLast: 3 }))).toBe("Missed 2 in a row; today puts you back on track");
    expect(streakLine(habit({ streak: 4, best: 4, doneToday: true, lastDone: "2026-11-22", daysSinceLast: 0 }))).toBe("🔥 4 days in a row, your best yet");
    expect(streakLine(habit({ task: { id: 2, title: "Long run", repeat_rule: "weekly", habit: true } as Task, streak: 2, best: 2, lastDone: "2026-11-15", daysSinceLast: 7 }))).toBe("🔥 2 weeks in a row: keep it going");
  });
  it("its week, Monday to Sunday", () => {
    const week = (["done", "done", "skipped", "missed", "done", "due", "ahead"] as const).map((state, n) => ({ day: `2026-11-${16 + n}`, state }));
    expect(weekMarks(habit({ week }))).toBe("✓ ✓ – ✗ ✓ ○ ·");
  });
});

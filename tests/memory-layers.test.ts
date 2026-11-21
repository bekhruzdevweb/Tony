/**
 * Layered memory (22 Nov), the pure rules: this week, this month, always; what
 * every reply sees; the Sunday review's rails, its summary, and /memory.
 */
import { describe, expect, it } from "vitest";
import {
  checkReview,
  currentGoals,
  higherLayer,
  isAlive,
  memoryBlock,
  memoryPage,
  normalNote,
  plainReview,
  readLayer,
  reviewSummary,
  type MemoryNote,
} from "../src/lib/memory-rules";

const now = new Date("2026-11-22T16:30:00Z"); // Sun 22 Nov, 21:30 in Tashkent
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
let next = 1;
/** A note `age` days old, last confirmed then (or just now, with `fresh`). */
const note = (fact: string, layer: MemoryNote["layer"], age: number, extra: Partial<MemoryNote> & { fresh?: boolean } = {}): MemoryNote => {
  const { fresh, ...rest } = extra;
  return { id: next++, fact, layer, goal: false, mentions: 1, created_at: daysAgo(age), confirmed_at: daysAgo(fresh ? 0 : age), ...rest };
};

describe("layers", () => {
  it("are read leniently and never move a note down", () => {
    expect(readLayer("weekly")).toBe("week");
    expect(readLayer("this month")).toBe("month");
    expect(readLayer("permanent")).toBe("always");
    expect(readLayer(undefined)).toBe("always");
    expect(higherLayer("week", "month")).toBe("month");
    expect(higherLayer("always", "week")).toBe("always");
  });

  it("older rows without a layer are always notes, alive for good", () => {
    const old = normalNote({ id: 1, fact: "Teaches adults", created_at: daysAgo(400) });
    expect(old).toMatchObject({ layer: "always", goal: false, mentions: 1, confirmed_at: old.created_at });
    expect(isAlive(old, now)).toBe(true);
  });

  it("a week note fades after a week without coming up, a month note after a month", () => {
    expect(isAlive(note("IELTS first", "week", 6), now)).toBe(true);
    expect(isAlive(note("IELTS first", "week", 8), now)).toBe(false);
    expect(isAlive(note("Grammar series", "month", 30), now)).toBe(true);
    expect(isAlive(note("Grammar series", "month", 32), now)).toBe(false);
  });
});

describe("what every reply sees", () => {
  it("grouped by layer, goals marked, faded notes left out", () => {
    const block = memoryBlock(
      [note("Works out in the evenings", "always", 40), note("Grammar series this month", "month", 10, { goal: true }), note("IELTS prep is the priority", "week", 2, { goal: true }), note("Old plan", "week", 9)],
      now,
    );
    expect(block).toMatch(/^Always:\n\[\d+\] Works out in the evenings\nThis month:\n\[\d+\] 🎯 Grammar series this month\nThis week:\n\[\d+\] 🎯 IELTS prep is the priority$/);
    expect(block).not.toContain("Old plan");
  });

  it("goals for plans and the morning brief: this week's first, never always notes or faded ones", () => {
    const goals = currentGoals(
      [note("Grammar series", "month", 10, { goal: true }), note("IELTS prep", "week", 1, { goal: true }), note("Be kind", "always", 50, { goal: true }), note("Faded goal", "week", 9, { goal: true })],
      now,
    );
    expect(goals.map((goal) => goal.fact)).toEqual(["IELTS prep", "Grammar series"]);
  });
});

describe("the Sunday review", () => {
  it("plain rules: what came up again moves up, what faded goes, always notes are never touched", () => {
    const again = note("Films reels on Saturdays", "week", 6, { mentions: 2 });
    const faded = note("Finish the slides by Friday", "week", 9);
    const settled = note("Building a new app", "month", 30, { mentions: 3, fresh: true });
    const always = note("Lives in Xonqa", "always", 100);
    expect(plainReview([again, faded, settled, always], now)).toEqual([
      { id: again.id, action: "promote", to: "month" },
      { id: faded.id, action: "drop" },
      { id: settled.id, action: "promote", to: "always" },
    ]);
  });

  it("the model's answer is held to the rails", () => {
    const young = note("Filming on Fridays", "week", 1);
    const held = note("IELTS prep is the priority", "week", 5);
    const fresh = note("Reel about phrasal verbs", "week", 3, { fresh: true });
    const stale = note("Slides by Wednesday", "week", 6);
    const newMonth = note("Grammar series", "month", 10);
    const always = note("Teaches adults", "always", 90);
    const actions = checkReview(
      [young, held, fresh, stale, newMonth, always],
      [
        { id: young.id, action: "promote" }, // too young to have held: kept
        { id: held.id, action: "promote" },
        { id: held.id, action: "drop" }, // a second answer for the same note is ignored
        { id: fresh.id, action: "drop" }, // confirmed today: kept
        { id: newMonth.id, action: "promote" }, // three weeks first: kept
        { id: always.id, action: "drop" }, // never touched
        { id: 999, action: "drop" }, // not a note
      ],
      now,
    );
    expect(actions).toEqual([
      { id: young.id, action: "keep" },
      { id: held.id, action: "promote", to: "month" },
      { id: fresh.id, action: "keep" },
      { id: newMonth.id, action: "keep" },
    ]);
    // "stale" was passed over: still within its week, the rules leave it.
    expect(actions.some((action) => action.id === stale.id)).toBe(false);
  });

  it("a note the model passed over is left to the plain rules", () => {
    const faded = note("Old focus", "week", 10);
    expect(checkReview([faded], [], now)).toEqual([{ id: faded.id, action: "drop" }]);
  });

  it("the summary is three short lines, and nothing to say is no message", () => {
    const text = reviewSummary({
      learned: ["IELTS prep is the priority this week", "Exam on 5 December", "Wants Tony to plan mornings first", "Films on Saturdays"],
      promoted: [{ fact: "Building a new app and planning a grammar series", to: "month" }],
      dropped: ["Slides by Wednesday"],
    });
    expect(text).toBe(
      [
        "🧠 **Sunday memory review**, sir.",
        "📝 **Learned** (4): IELTS prep is the priority this week · Exam on 5 December · Wants Tony to plan mornings first · +1 more",
        "⬆️ **Moved up**: Building a new app and planning a grammar series → This month",
        "🗑 **Dropped**: Slides by Wednesday",
      ].join("\n"),
    );
    expect(reviewSummary({ learned: [], promoted: [], dropped: [] })).toBeUndefined();
  });
});

describe("/memory", () => {
  it("shows this week, this month, then always, numbered on so each 🗑 matches", () => {
    const always = note("Works out in the evenings", "always", 40);
    const month = note("Grammar series", "month", 10, { goal: true });
    const week = note("IELTS prep", "week", 2, { goal: true });
    const faded = note("Old plan", "week", 9);
    const page = memoryPage([always, month, week, faded], now);
    expect(page.ids).toEqual([week.id, faded.id, month.id, always.id]);
    expect(page.lines).toEqual(["", "**This week**", "1. 🎯 IELTS prep", "2. Old plan · _fading_", "", "**This month**", "3. 🎯 Grammar series", "", "**Always**", "4. Works out in the evenings"]);
    expect(page.hidden).toBe(0);
  });

  it("past the cap, the oldest always notes are left out and counted", () => {
    const notes = [...Array.from({ length: 5 }, (_, index) => note(`Fact ${index + 1}`, "always", 50 - index)), note("This week", "week", 1)];
    const page = memoryPage(notes, now, 3);
    expect(page.lines.filter((line) => /^\d+\./.test(line))).toEqual(["1. This week", "2. Fact 4", "3. Fact 5"]);
    expect(page.hidden).toBe(3);
  });

  it("with week and month filling the cap, no always note is shown (slice(-0) would show them all)", () => {
    const page = memoryPage([note("A", "always", 30), note("B", "week", 1), note("C", "month", 9)], now, 2);
    expect(page.ids).toHaveLength(2);
    expect(page.hidden).toBe(1);
  });
});

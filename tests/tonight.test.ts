/**
 * Regression tests for the evening of 20 November 2026 (Tashkent).
 */
import { describe, expect, it } from "vitest";
import { asksToClean, claimsSent, isOverdue } from "../src/lib/brain/checks";

const at = (local: string) => new Date(`${local}:00+05:00`);
const NOW = at("2026-11-20T22:30");
const row = (title: string, local: string, extra: Partial<{ status: string; kind: string | null }> = {}) => ({ title, due_at: at(local).toISOString(), status: "todo", kind: null, ...extra });

describe("Overdue listed as empty while 5 tasks were overdue", () => {
  const tasks = [
    row("Reply to the school", "2026-11-18T16:00"),
    row("Post the forum poster", "2026-11-19T19:00"),
    // Overdue since earlier today: the old filter ("before today began") missed these.
    row("Podcast notes", "2026-11-20T14:00"),
    row("Film the grammar series", "2026-11-20T16:30"),
    row("Reading", "2026-11-20T21:00"),
    // Not overdue: still ahead, started, done, or a prayer.
    row("Call the barber", "2026-11-21T08:30"),
    row("Workout", "2026-11-20T18:00", { status: "in_progress" }),
    row("Unit 5 slides", "2026-11-20T09:00", { status: "done" }),
    row("Isha", "2026-11-20T18:57", { kind: "prayer" }),
  ];
  it("finds all five", () => {
    expect(tasks.filter((task) => isOverdue(task, NOW)).map((task) => task.title)).toEqual([
      "Reply to the school",
      "Post the forum poster",
      "Podcast notes",
      "Film the grammar series",
      "Reading",
    ]);
  });
});

describe('"clean the chat"', () => {
  it("is understood in its usual forms", () => {
    for (const text of ["clean the chat", "Tony, clear the chat please", "tidy up the chat", "clean my messages"]) expect(asksToClean(text)).toBe(true);
    expect(asksToClean("clean the kitchen at 6")).toBe(false);
  });
});

describe('"Here it is, sir, the picture…" with no photo sent', () => {
  it("recognises a reply that claims something was sent", () => {
    expect(claimsSent("Here it is, sir, the picture from the forum.")).toBe(true);
    expect(claimsSent("I've sent it to you.")).toBe(true);
    expect(claimsSent("Your workout is at 18:00.")).toBe(false);
  });
});

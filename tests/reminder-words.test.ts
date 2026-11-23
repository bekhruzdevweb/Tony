/**
 * What a reminder says matches what happens next (his chat, 23 Nov).
 */
import { describe, expect, it } from "vitest";
import { aloudNudge, persistentReminder } from "../src/lib/reminder-messages";

const at = (local: string) => new Date(`${local}:00+05:00`);

describe("the nudge said aloud after two went unanswered", () => {
  // 23 Nov 12:00: "Final call, sir: Discuss going to Tashkent. It was due at 10:45." and then the chase went
  // on: "Still nothing logged for Discuss going to Tashkent" at 13:00, 14:00, 15:00 and 16:00.
  it("is never called final, since the chase goes on", () => {
    const words = aloudNudge("Discuss going to Tashkent", "10:45");
    expect(words).toBe("Sir, Discuss going to Tashkent is still waiting. It was due at 10:45. A tap on the reminder settles it.");
    expect(words.toLowerCase()).not.toContain("final");
  });

  it("names no time for a task without one", () => {
    expect(aloudNudge("Make my own IELTS plan")).toBe("Sir, Make my own IELTS plan is still waiting. A tap on the reminder settles it.");
  });

  it("the written step it goes with still says when Tony checks again", () => {
    const task = { id: 94, title: "Discuss going to Tashkent", due_at: at("2026-11-23T10:45").toISOString() } as never;
    const step = persistentReminder(task, 3, at("2026-11-23T13:00"), at("2026-11-23T14:00"));
    expect(step.text).toBe("Still nothing logged for <b>Discuss going to Tashkent</b>, sir. I'll check again at <b>14:00</b>.");
  });
});

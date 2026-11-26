import { describe, expect, it } from "vitest";
import { staysPut } from "../src/lib/stays-put";

describe("a missed workout stays on its day", () => {
  it("a workout session stays put; other tasks can be carried", () => {
    expect(staysPut({ title: "Workout: Upper B (pull + grip)", tags: ["workout", "together"], kind: null })).toBe(true);
    expect(staysPut({ title: "Gym", tags: ["workout"], kind: null })).toBe(true);
    expect(staysPut({ title: "Workout: Legs B", tags: [], kind: null })).toBe(true);
    expect(staysPut({ title: "Reply to Aziz", tags: [], kind: null })).toBe(false);
    expect(staysPut({ title: "IELTS: Writing Task 2", tags: ["ielts"], kind: null })).toBe(false);
  });
});

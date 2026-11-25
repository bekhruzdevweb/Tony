import { describe, expect, it } from "vitest";
import { planningWeek, weekNamed, weekStart } from "../src/lib/week-rules";

describe("the weekly planner's weeks", () => {
  it("a week runs Monday to Sunday", () => {
    expect(weekStart("2026-11-25")).toBe("2026-11-23");
    expect(weekStart("2026-11-23")).toBe("2026-11-23");
    expect(weekStart("2026-11-29")).toBe("2026-11-23");
    expect(weekStart("2026-11-30")).toBe("2026-11-30");
  });
  it("opens on next week on a Sunday, on this week otherwise", () => {
    expect(planningWeek("2026-11-25")).toBe("2026-11-23");
    expect(planningWeek("2026-11-29")).toBe("2026-11-30");
  });
  it("reads 'this', 'next' and a date", () => {
    expect(weekNamed("this", "2026-11-29")).toBe("2026-11-23");
    expect(weekNamed("next", "2026-11-25")).toBe("2026-11-30");
    expect(weekNamed("2026-12-03", "2026-11-25")).toBe("2026-11-30");
    expect(weekNamed(undefined, "2026-11-29")).toBe("2026-11-30");
  });
});

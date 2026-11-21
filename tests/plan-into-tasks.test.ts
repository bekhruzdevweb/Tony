/**
 * 22 Nov 02:14–02:32: a plan into his schedule. Repeats end on the plan's last
 * day; a typo or a date is not a lost detail; the end of Tony's long answer
 * (his offer) survives the history clip.
 */
import { describe, expect, it } from "vitest";
import { clip } from "../src/lib/brain/index";
import { lostDetails, notesToKeep } from "../src/lib/brain/reliability";
import { nextOccurrence } from "../src/lib/recurrence";

describe("a repeat with an end", () => {
  const monday = { due_at: "2027-01-11T13:00:00Z", repeat_rule: "weekly" as const };
  it("comes round weekly until its last day, then stops", () => {
    expect(nextOccurrence({ ...monday, repeat_until: "2027-01-17" }, new Date("2027-01-11T14:00:00Z"))).toBeUndefined();
    expect(nextOccurrence({ ...monday, repeat_until: "2027-01-18" }, new Date("2027-01-11T14:00:00Z"))?.toISOString()).toBe("2027-01-18T13:00:00.000Z");
    expect(nextOccurrence({ ...monday, repeat_until: null }, new Date("2027-01-11T14:00:00Z"))?.toISOString()).toBe("2027-01-18T13:00:00.000Z");
  });
});

describe("details kept", () => {
  it("'buy supbase pro on 26 of november': the typo and the date are not lost details (no quote in the notes)", () => {
    expect(lostDetails("buy supbase pro on 26 of november", ["Buy Supabase Pro"])).toEqual([]);
    expect(notesToKeep("Remind me to buy supbase pro on 26 of november", [{ title: "Buy Supabase Pro", notes: null }])).toBeUndefined();
  });
  it("a detail really dropped is still quoted, for one task, not copied into each of several", () => {
    const message = "remind me to send the worksheet for international students at the speaking club";
    expect(notesToKeep(message, [{ title: "Send the worksheet", notes: null }])).toContain("From your message:");
    expect(notesToKeep(message, [{ title: "Send the worksheet", notes: null }], { quote: false })).toBeUndefined();
  });
});

describe("history", () => {
  it("a long message keeps its start and its end (where Tony's offer is)", () => {
    const long = `Start of the answer.\n${"middle line\n".repeat(200)}Do you want me to turn the weekly rhythm into recurring tasks?`;
    const kept = clip(long);
    expect(kept.length).toBeLessThan(1300);
    expect(kept.startsWith("Start of the answer.")).toBe(true);
    expect(kept.endsWith("Do you want me to turn the weekly rhythm into recurring tasks?")).toBe(true);
    expect(clip("short")).toBe("short");
  });
});

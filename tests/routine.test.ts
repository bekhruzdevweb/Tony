/**
 * How Tony decides: his routine, kinds of task, learned times, and the
 * propose-or-ask rule for a day without a time. Real tasks from his list.
 */
import { describe, expect, it } from "vitest";
import {
  checkInDays,
  checkInDue,
  checkInTime,
  decideSlot,
  DEFAULT_ROUTINE,
  freeStarts,
  kindOf,
  learnedMinute,
  normalizeField,
  parseDays,
  parseWindows,
  partsOfDay,
  withSample,
  type Routine,
} from "../src/lib/routine-rules";

const at = (local: string) => new Date(`${local}:00+05:00`);
const hhmm = (date: Date) => new Date(date.getTime() + 5 * 60 * 60_000).toISOString().slice(11, 16);
const block = (from: string, minutes: number) => ({ start: at(from).getTime(), end: at(from).getTime() + minutes * 60_000 });
const routine = (patch: Partial<Routine> = {}): Routine => ({ ...DEFAULT_ROUTINE, ...patch });
// Friday 20 Nov 2026, 23:20: he plans the weekend and Monday.
const NOW = at("2026-11-20T23:20");

describe("Reading his routine", () => {
  it("reads days and windows the way he says them", () => {
    expect(parseDays("Mon-Fri")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("Sat and Sun")).toEqual([0, 6]);
    expect(parseDays("sunday")).toEqual([0]);
    expect(parseWindows("Mon-Fri 14:00-18:00; Sat 10:00-12:00")).toEqual([
      { days: [1, 2, 3, 4, 5], start: 840, end: 1080 },
      { days: [6], start: 600, end: 720 },
    ]);
    expect(parseWindows("6-8pm")).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], start: 1080, end: 1200 }]);
    expect(parseWindows("evenings")).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], start: 1080, end: 1260 }]);
    expect(parseWindows("whenever")).toBeUndefined();
  });
  it("stores each field one way", () => {
    expect(normalizeField("teaching", "mon-fri 2pm-6pm")).toBe("Mon–Fri 14:00–18:00");
    expect(normalizeField("content", "10-12")).toBe("10:00–12:00");
    expect(normalizeField("wake", "6.30 am")).toBe("06:30");
    expect(normalizeField("free_days", "Sunday")).toBe("Sun");
    expect(normalizeField("coding", "none")).toBeNull();
    expect(normalizeField("coding", "whenever I can")).toBeUndefined();
  });
});

describe("Kinds of task (his real titles)", () => {
  it("knows content, coding, learning, prep, teaching, workouts and errands", () => {
    expect(kindOf("Posting stories on Instagram")).toBe("content");
    expect(kindOf("Shoot app tutorial on Zoom")).toBe("content");
    expect(kindOf("Update fitness app")).toBe("coding");
    expect(kindOf("Plan new chatbot agent features")).toBe("coding");
    expect(kindOf("Watch: Instagram Masterclass (Brock Johnson)")).toBe("learn");
    expect(kindOf("Watch podcast and take notes")).toBe("learn");
    expect(kindOf("Make English File presentation")).toBe("prep");
    expect(kindOf("Launch beginner and elementary course")).toBe("prep");
    expect(kindOf("Conduct the lesson")).toBe("teaching");
    expect(kindOf("Workout")).toBe("workout");
    expect(kindOf("Call the barber")).toBe("errand");
    expect(kindOf("Buy a zippered shirt")).toBe("errand");
    expect(kindOf("Message the teacher on Instagram")).toBe("errand");
  });
});

describe("Learning from his moves", () => {
  it("needs two moves, then takes the middle one", () => {
    expect(learnedMinute([600])).toBeUndefined();
    expect(learnedMinute([600, 630])).toBe(615);
    expect(learnedMinute([600, 630, 1200])).toBe(630);
    const learned = withSample(withSample({}, "content", 600), "content", 630);
    expect(learned.content).toEqual([600, 630]);
    expect(withSample({ content: [1, 2, 3, 4, 5, 6, 7, 8] }, "content", 9).content).toHaveLength(8);
  });
});

describe("Parts of the day he names", () => {
  it("reads 'Sunday afternoon or noon' and 'Sunday evening'", () => {
    expect(partsOfDay("schedule it for upcoming Sunday afternoon or noon").map((p) => p.label)).toEqual(["around noon", "in the afternoon"]);
    expect(partsOfDay("Maybe Sunday evening.").map((p) => p.label)).toEqual(["in the evening"]);
    expect(partsOfDay("remind me to watch this video in the upcoming Monday")).toEqual([]);
  });
});

describe("Day but no time: propose one slot, or ask with real free ones", () => {
  const monday = at("2026-11-23T12:00");
  it("content with content hours: ONE slot in them", () => {
    const decision = decideSlot({ minutes: 15, kind: "content", day: monday, now: NOW, routine: routine({ content: "10:00-12:00" }), busy: [] });
    expect(decision).toMatchObject({ decision: "propose", why: "your content time" });
    expect(hhmm((decision as { at: Date }).at)).toBe("10:00");
  });
  it("his learned time beats the routine's hours", () => {
    const decision = decideSlot({ minutes: 30, kind: "learn", day: monday, now: NOW, routine: routine({ learned: { learn: [1260, 1275, 1260] } }), busy: [] });
    expect(decision).toMatchObject({ decision: "propose", why: "you usually watch and read around 21:00" });
  });
  it("a part of the day he named is clear enough (Sunday afternoon or noon)", () => {
    const decision = decideSlot({ minutes: 90, kind: "coding", day: at("2026-11-22T12:00"), now: NOW, routine: routine(), busy: [], parts: partsOfDay("Sunday afternoon or noon") });
    expect(decision).toMatchObject({ decision: "propose", why: "around noon, as you said" });
    expect(hhmm((decision as { at: Date }).at)).toBe("12:00");
  });
  it("not sure (watching a video, no habit): asks once, with 2–3 real free slots", () => {
    const busy = [block("2026-11-23T10:00", 240)]; // the 4-hour Instagram masterclass
    const decision = decideSlot({ minutes: 30, kind: "learn", day: monday, now: NOW, routine: routine({ workout: "18:00-20:00" }), busy });
    expect(decision.decision).toBe("ask");
    const options = (decision as { options: Date[] }).options;
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    for (const option of options) expect(option.getTime() + 30 * 60_000 + 10 * 60_000 <= busy[0].start || option.getTime() >= busy[0].end + 10 * 60_000).toBe(true);
  });
  it("never two things in one slot: a 90-minute task blocks 90 minutes", () => {
    const busy = [block("2026-11-23T10:00", 90)];
    const starts = freeStarts({ minutes: 60, kind: "coding", day: monday, now: NOW, routine: routine(), busy });
    expect(starts.map((start) => hhmm(new Date(start)))).not.toContain("10:30");
    expect(starts.map((start) => hhmm(new Date(start)))).not.toContain("11:30");
    expect(starts.map((start) => hhmm(new Date(start)))).toContain("11:45");
    expect(starts.map((start) => hhmm(new Date(start)))).toContain("08:45"); // ends 09:45, ten minutes clear of 10:00
    expect(starts.map((start) => hhmm(new Date(start)))).not.toContain("09:00"); // would end right at 10:00
  });
  it("keeps clear of teaching hours on working days, not on free days", () => {
    const teaching = routine({ teaching: "Mon-Fri 14:00-18:00", free_days: "Sun" });
    const monStarts = freeStarts({ minutes: 60, kind: "coding", day: monday, now: NOW, routine: teaching, busy: [] }).map((s) => hhmm(new Date(s)));
    expect(monStarts).not.toContain("15:00");
    const classStarts = freeStarts({ minutes: 60, kind: "teaching", day: monday, now: NOW, routine: teaching, busy: [] }).map((s) => hhmm(new Date(s)));
    expect(classStarts).toContain("15:00");
  });
  it("a full day: none", () => {
    expect(decideSlot({ minutes: 60, kind: "other", day: monday, now: NOW, routine: routine(), busy: [block("2026-11-23T06:00", 18 * 60)] })).toEqual({ decision: "none" });
  });
});

describe("Check-ins: 'remind me if I don't check it for 2 days' (23:17, ignored)", () => {
  it("reads the days", () => {
    expect(checkInDays("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days")).toBe(2);
    expect(checkInDays("nudge me if I haven't touched it in a week")).toBe(7);
    expect(checkInDays("remind me tomorrow")).toBeUndefined();
  });
  it("never fires at night: 23:17 + 2 days becomes 10:00 the morning after", () => {
    expect(checkInTime(at("2026-11-20T23:17"), 2, routine()).toISOString()).toBe(at("2026-11-23T10:00").toISOString());
    expect(checkInTime(at("2026-11-20T14:00"), 2, routine()).toISOString()).toBe(at("2026-11-22T14:00").toISOString());
  });
  it("only if the task really sat untouched", () => {
    expect(checkInDue({ now: at("2026-11-23T10:00"), updatedAt: at("2026-11-20T23:19"), everyDays: 2, routine: routine() })).toEqual({ send: true });
    const later = checkInDue({ now: at("2026-11-23T10:00"), updatedAt: at("2026-11-22T12:00"), everyDays: 2, routine: routine() });
    expect(later).toEqual({ send: false, next: at("2026-11-24T12:00") });
  });
});

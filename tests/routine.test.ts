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
    // His list of kinds: podcasts/videos (watch), study, content, coding, workouts, errands.
    expect(kindOf("Watch: Instagram Masterclass (Brock Johnson)")).toBe("watch");
    expect(kindOf("Watch podcast and take notes")).toBe("watch");
    expect(kindOf("Watch reel: humor plus education")).toBe("watch");
    expect(kindOf("Check YouTube video, start doing it")).toBe("watch");
    expect(kindOf("Study IELTS reading")).toBe("study");
    expect(kindOf("Read the grammar book")).toBe("study");
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

describe("Day but no time: ALWAYS asked, 2–3 real free slots, best first with a reason", () => {
  const monday = at("2026-11-23T12:00");
  type Asked = { decision: "ask"; options: { at: Date; why?: string }[]; taken?: string };
  const asked = (decision: ReturnType<typeof decideSlot>) => {
    expect(decision.decision).toBe("ask");
    return decision as Asked;
  };
  it("content with content hours: asked, never picked; the first option is in them, 'your content time'", () => {
    const decision = asked(decideSlot({ minutes: 15, kind: "content", day: monday, now: NOW, routine: routine({ content: "10:00-12:00" }), busy: [] }));
    expect(hhmm(decision.options[0].at)).toBe("10:00");
    expect(decision.options[0].why).toBe("your content time");
    expect(decision.options.length).toBeGreaterThanOrEqual(2);
    expect(decision.options.length).toBeLessThanOrEqual(3);
  });
  it("his usual time comes first, with that reason ('you usually watch videos around 21:00')", () => {
    const decision = asked(decideSlot({ minutes: 30, kind: "watch", day: monday, now: NOW, routine: routine({ learned: { watch: [1260, 1275, 1260] } }), busy: [] }));
    expect(hhmm(decision.options[0].at)).toBe("21:00");
    expect(decision.options[0].why).toBe("you usually watch videos around 21:00");
  });
  it("an old 'learn' habit counts as watching", () => {
    const decision = asked(decideSlot({ minutes: 30, kind: "watch", day: monday, now: NOW, routine: routine({ learned: { learn: [1230, 1230] } }), busy: [] }));
    expect(hhmm(decision.options[0].at)).toBe("20:30");
  });
  it("a part of the day he named comes first (Sunday afternoon or noon), still asked", () => {
    const decision = asked(decideSlot({ minutes: 90, kind: "coding", day: at("2026-11-22T12:00"), now: NOW, routine: routine(), busy: [], parts: partsOfDay("Sunday afternoon or noon") }));
    expect(hhmm(decision.options[0].at)).toBe("12:00");
    expect(decision.options[0].why).toBe("around noon, as you said");
  });
  it("not sure (a video, no habit): 2–3 real free slots, clear of the masterclass, which is named as taken", () => {
    const busy = [{ ...block("2026-11-23T10:00", 240), title: "Watch: Instagram Masterclass" }];
    const decision = asked(decideSlot({ minutes: 30, kind: "watch", day: monday, now: NOW, routine: routine({ workout: "18:00-20:00" }), busy }));
    expect(decision.options.length).toBeGreaterThanOrEqual(2);
    expect(decision.options.length).toBeLessThanOrEqual(3);
    for (const { at: option } of decision.options) expect(option.getTime() + 30 * 60_000 + 10 * 60_000 <= busy[0].start || option.getTime() >= busy[0].end + 10 * 60_000).toBe(true);
    expect(decision.taken).toBe("10:00–14:00 is taken by **Watch: Instagram Masterclass**");
    // Every option has a reason he can read; the first is the best.
    expect(decision.options[0].why).toBeTruthy();
  });
  it("options are at least 90 minutes apart, inside his waking day, and never in the past", () => {
    const tonight = at("2026-11-20T19:00");
    const decision = asked(decideSlot({ minutes: 30, kind: "other", day: tonight, now: tonight, routine: routine(), busy: [] }));
    const times = decision.options.map((option) => option.at.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(90 * 60_000);
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(tonight.getTime() + 15 * 60_000);
      expect(time + 30 * 60_000).toBeLessThanOrEqual(at("2026-11-20T23:00").getTime());
    }
  });
  it("'decide yourself for videos': Tony picks the best slot himself, and says why", () => {
    const decision = decideSlot({ minutes: 30, kind: "watch", day: monday, now: NOW, routine: routine({ auto_kinds: ["watch"], learned: { watch: [1230, 1230] } }), busy: [] });
    expect(decision).toMatchObject({ decision: "auto", why: "you usually watch videos around 20:30" });
    expect(hhmm((decision as { at: Date }).at)).toBe("20:30");
    // Other kinds are still asked.
    expect(decideSlot({ minutes: 30, kind: "coding", day: monday, now: NOW, routine: routine({ auto_kinds: ["watch"] }), busy: [] }).decision).toBe("ask");
  });
  it("a 4-hour video with no 4-hour gap: offered in two halves, each in a real free gap", () => {
    const busy = [block("2026-11-23T08:00", 120), block("2026-11-23T12:30", 90), block("2026-11-23T16:30", 90), block("2026-11-23T20:30", 90)];
    const decision = decideSlot({ minutes: 240, kind: "watch", day: monday, now: NOW, routine: routine(), busy });
    expect(decision.decision).toBe("split");
    const { parts, minutes } = decision as { parts: Date[]; minutes: number };
    expect(minutes).toBe(120);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      const free = freeStarts({ minutes: 120, kind: "watch", day: monday, now: NOW, routine: routine(), busy });
      expect(free).toContain(part.getTime());
    }
    expect(Math.abs(parts[1].getTime() - parts[0].getTime())).toBeGreaterThanOrEqual(130 * 60_000);
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

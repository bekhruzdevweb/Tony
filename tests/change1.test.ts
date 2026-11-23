/**
 * Change 1 (21 Nov): a day without a time is always asked about. The pure
 * pieces: which kinds "decide yourself for …" names, a time typed after
 * [✏️ Other time], "tomorrow" after midnight, the words of the question and
 * its buttons. Real cases from his chat.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTINE, kindsFromWords, routineLines, typedTime, type Routine } from "../src/lib/routine-rules";
import { autoReceipt, awaitsAnswer, slotButtons, slotQuestion, splitQuestion } from "../src/lib/slot-text";
import { notesToKeep } from "../src/lib/brain/reliability";
import { hisTomorrow, localDate } from "../src/lib/time";

const at = (local: string) => new Date(`${local}:00+05:00`);
const routine = (patch: Partial<Routine> = {}): Routine => ({ ...DEFAULT_ROUTINE, ...patch });

describe("'decide yourself for <kind>': the kinds he names", () => {
  it("reads his words", () => {
    expect(kindsFromWords("videos and podcasts")).toEqual(["watch"]);
    expect(kindsFromWords("coding and workouts")).toEqual(["coding", "workout"]);
    expect(kindsFromWords("my content")).toEqual(["content"]);
    expect(kindsFromWords("errands, calls and shopping")).toEqual(["errand"]);
    expect(kindsFromWords("studying for IELTS")).toEqual(["study"]);
    expect(kindsFromWords("everything").length).toBeGreaterThanOrEqual(8);
    expect(kindsFromWords("the weather")).toEqual([]);
  });
  it("/routine shows what Tony may pick himself", () => {
    expect(routineLines(routine({ auto_kinds: ["watch", "coding"] }))).toContain("Tony picks the time for: videos and podcasts, coding");
    expect(routineLines(routine()).join("\n")).not.toMatch(/Tony picks/);
  });
});

describe("A time typed after [✏️ Other time]", () => {
  const tuesday = at("2026-11-24T12:00");
  const input = { day: tuesday, now: at("2026-11-21T01:25"), routine: routine(), kind: "watch" as const };
  it("a clear time is placed on that day", () => {
    expect(localDate(typedTime("20:30", input)!)).toBe("2026-11-24");
    expect(typedTime("20:30", input)!.toISOString()).toBe(at("2026-11-24T20:30").toISOString());
    expect(typedTime("at 8 pm", input)!.toISOString()).toBe(at("2026-11-24T20:00").toISOString());
    expect(typedTime("08:30", input)!.toISOString()).toBe(at("2026-11-24T08:30").toISOString());
    expect(typedTime("21.15", input)!.toISOString()).toBe(at("2026-11-24T21:15").toISOString());
  });
  it("'8:30' is 08:30 or 20:30: his usual time for this kind decides; with no habit it is left to the brain", () => {
    expect(typedTime("8:30", { ...input, routine: routine({ learned: { watch: [1230, 1240] } }) })!.toISOString()).toBe(at("2026-11-24T20:30").toISOString());
    expect(typedTime("8:30", input)).toBeUndefined();
    // "5" can only be 17:00 in his waking day.
    expect(typedTime("5", input)!.toISOString()).toBe(at("2026-11-24T17:00").toISOString());
  });
  it("a sentence is not a typed time", () => {
    expect(typedTime("after my evening workout", input)).toBeUndefined();
    expect(typedTime("tomorrow at 9 instead", input)).toBeUndefined();
  });
  it("a time already past that day is not placed", () => {
    expect(typedTime("09:00", { ...input, day: at("2026-11-21T12:00"), now: at("2026-11-21T10:00") })).toBeUndefined();
  });
});

describe("'Tomorrow' after midnight is the day after he sleeps (task 43, 00:49: planned on Sunday)", () => {
  it("between 00:00 and 05:00 it is the day just begun; otherwise the next one", () => {
    expect(localDate(hisTomorrow(at("2026-11-21T00:49")))).toBe("2026-11-21");
    expect(localDate(hisTomorrow(at("2026-11-21T04:59")))).toBe("2026-11-21");
    expect(localDate(hisTomorrow(at("2026-11-20T21:00")))).toBe("2026-11-21");
    expect(localDate(hisTomorrow(at("2026-11-21T05:00")))).toBe("2026-11-22");
  });
});

describe("The question: one message, best first with its reason, plus Other", () => {
  const options = [
    { at: at("2026-11-23T20:30"), why: "you usually watch videos around 20:30" },
    { at: at("2026-11-23T14:15"), why: "right after **Watch: Instagram Masterclass** ends" },
    { at: at("2026-11-23T07:00"), why: "the first free time" },
  ];
  it("reads like his #284 case should have", () => {
    const text = slotQuestion({ title: "Watch: Mosseri AI setup", marks: " · 🔗 link", when: "on Mon 23 Nov", options, taken: "10:00–14:00 is taken by **Watch: Instagram Masterclass**" });
    expect(text).toBe(
      "**Watch: Mosseri AI setup** · 🔗 link\nWhen on Mon 23 Nov? Best: **20:30**, you usually watch videos around 20:30.\n10:00–14:00 is taken by **Watch: Instagram Masterclass**.",
    );
    expect(text.match(/\?/g)).toHaveLength(1);
    expect(text).not.toMatch(/inbox|sir/);
  });
  it("a single free time is said as such", () => {
    expect(slotQuestion({ title: "Call the bank", marks: "", when: "tomorrow, Sat 21 Nov", options: [options[0]] })).toBe("**Call the bank**\nWhen tomorrow, Sat 21 Nov? Only **20:30** is free, you usually watch videos around 20:30.");
  });
  it("buttons: the best first with ⭐, then the others, then [No time] [✏️ Other time]", () => {
    const rows = slotButtons({ kind: "ask", taskId: 37, day: "2026-11-23", options });
    expect(rows.map((row) => row.map((button) => button.text))).toEqual([["⭐ 20:30", "14:15", "07:00"], ["No time", "✏️ Other time"]]);
    expect(rows[0][0].data).toBe(`sl:at:37:${Math.round(options[0].at.getTime() / 60_000)}`);
    expect(rows[1][0].data).toBe("sl:none:37:2026-11-23");
    expect(rows[1][1].data).toBe("sl:other:37:2026-11-23");
    for (const button of rows.flat()) expect(button.data.length).toBeLessThanOrEqual(64);
  });
  it("Tony's own pick (only when he said 'decide yourself') says so, with [✏️ Change]", () => {
    expect(autoReceipt({ title: "Watch: Mosseri AI setup", marks: " · 🔗 link", when: "Mon 23 Nov, **20:30**", why: "you usually watch videos around 20:30" })).toBe(
      "✓ **Watch: Mosseri AI setup** → Mon 23 Nov, **20:30** · 🔗 link · my pick: you usually watch videos around 20:30",
    );
    expect(slotButtons({ kind: "auto", taskId: 37, day: "2026-11-23" }).flat().map((button) => button.text)).toEqual(["✏️ Change"]);
  });
  it("a split is offered, never made: [✂️ Split …] and [✏️ Other time]", () => {
    const parts = [at("2026-11-23T10:15"), at("2026-11-23T14:15")];
    expect(splitQuestion({ title: "Watch: Instagram Masterclass", marks: "", when: "on Mon 23 Nov", minutes: 120, total: 240, parts })).toBe(
      "**Watch: Instagram Masterclass**: 4 h won't fit in one go on Mon 23 Nov. Split it in two? **10:15** and **14:15**, 2 h each.",
    );
    const rows = slotButtons({ kind: "split", taskId: 40, day: "2026-11-23", parts });
    expect(rows.flat().map((button) => button.text)).toEqual(["✂️ Split 10:15 + 14:15", "✏️ Other time"]);
    expect(rows[0][0].data.length).toBeLessThanOrEqual(64);
  });
});

describe("#309: his instructions are never quoted into a task's notes", () => {
  it("'save this … remind me to check it after three days and start doing it': nothing to add beyond the link", () => {
    const message = "Hey Tony, save this YouTube video and remind me to check it after three days and start doing it. Remind me about it.";
    expect(notesToKeep(message, [{ title: "Check YouTube video, start doing it", notes: "https://youtu.be/w0H1-b044KY — check it and start doing it." }])).toBeUndefined();
  });
  it("real details still are kept (22:46: 'for the student from New York', 'elementary')", () => {
    const kept = notesToKeep("prepare a presentation for the student from New York, level elementary, about travel", [{ title: "Prepare presentation", notes: null }]);
    expect(kept).toMatch(/New York/);
    expect(kept).toMatch(/elementary/);
  });
});

describe("21 Nov 20:25 'Remind me to study Thinking fast and slow on notebooklm 23 November': the question waits for his answer", () => {
  it("a question about the time stays in the chat until he answers it; Tony's own pick is a receipt and is tidied away", () => {
    // The question was removed with the receipts at 23:26, unanswered: the day he named (Mon 23 Nov) lived only in its buttons.
    expect(awaitsAnswer({ kind: "ask" })).toBe(true);
    expect(awaitsAnswer({ kind: "split" })).toBe(true);
    expect(awaitsAnswer({ kind: "auto" })).toBe(false);
    expect(awaitsAnswer(undefined)).toBe(false);
  });
});

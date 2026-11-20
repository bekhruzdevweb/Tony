/**
 * Phase 1 (reliability, round two): the rules, each on the real message or
 * row that broke it (19–21 Nov). Written before the code.
 */
import { describe, expect, it } from "vitest";
import { mergeNotes, nightTomorrow, statedByHim, withoutInternals, withoutSendClaims } from "../src/lib/brain/reliability";
import { confirmationFor, savedMarks } from "../src/lib/brain/checks";
import { describeChange, undoPatch, type HistoryEntry } from "../src/lib/history-rules";
import { dayFromText } from "../src/lib/schedule";
import { formatWhen, hisDate, isNight } from "../src/lib/time";

const at = (local: string) => new Date(`${local}:00+05:00`);
const ymd = (date: Date) => new Date(date.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);

describe("8. Night rule: 00:00–05:00, 'tomorrow' is the day after he sleeps", () => {
  it("knows the night and the day he is living", () => {
    expect(isNight(at("2026-11-21T00:08"))).toBe(true);
    expect(isNight(at("2026-11-21T05:00"))).toBe(false);
    expect(hisDate(at("2026-11-21T00:08"))).toBe("2026-11-20");
    expect(hisDate(at("2026-11-21T09:00"))).toBe("2026-11-21");
  });
  it("21 Nov 00:08 'send a message tomorrow to my teacher' means Saturday 21, not Sunday", () => {
    expect(ymd(dayFromText("Remind me to send a message tomorrow to my teacher about asking advice, launching a group.", at("2026-11-21T00:08"))!)).toBe("2026-11-21");
    expect(ymd(dayFromText("remind me tomorrow", at("2026-11-21T09:00"))!)).toBe("2026-11-22");
    expect(ymd(dayFromText("tmr remind me to watch this podcast", at("2026-11-20T00:59"))!)).toBe("2026-11-20");
    expect(ymd(dayFromText("the day after tomorrow", at("2026-11-21T00:30"))!)).toBe("2026-11-22");
  });
  it("20 Nov 00:59 'tmr … at 2 p.m': the model's Saturday 14:00 becomes Friday 14:00", () => {
    expect(nightTomorrow(at("2026-11-21T14:00"), "tmr remind me to watch this podcast and take notes at 2 p.m", at("2026-11-20T00:59"))?.toISOString()).toBe(at("2026-11-20T14:00").toISOString());
    // Already right, or not about tomorrow, or not at night: left alone.
    expect(nightTomorrow(at("2026-11-20T14:00"), "tmr … at 2 p.m", at("2026-11-20T00:59"))).toBeUndefined();
    expect(nightTomorrow(at("2026-11-23T10:00"), "on Monday at 10", at("2026-11-20T00:59"))).toBeUndefined();
    expect(nightTomorrow(at("2026-11-22T10:00"), "tomorrow at 10", at("2026-11-21T09:00"))).toBeUndefined();
  });
  it("every confirmation states weekday and date", () => {
    expect(formatWhen(at("2026-11-21T08:30"), at("2026-11-20T17:31"))).toBe("tomorrow, Sat 21 Nov, 08:30");
    expect(formatWhen(at("2026-11-20T17:51"), at("2026-11-20T17:31"))).toBe("today, Fri 20 Nov, 17:51");
    expect(formatWhen(at("2026-11-23T10:00"), at("2026-11-20T17:31"))).toBe("Mon 23 Nov, 10:00");
    // At 00:08 on Saturday, Saturday 10:00 is "tomorrow" to him; 01:00 is still tonight.
    expect(formatWhen(at("2026-11-21T10:00"), at("2026-11-21T00:08"))).toBe("tomorrow, Sat 21 Nov, 10:00");
    expect(formatWhen(at("2026-11-21T01:00"), at("2026-11-21T00:08"))).toBe("tonight, Sat 21 Nov, 01:00");
    expect(confirmationFor([{ tool: "set_reminder", title: "Call the barber", status: "todo", due_at: at("2026-11-21T08:30").toISOString() }], at("2026-11-20T17:31"))).toBe(
      "✓ **Call the barber** → tomorrow, Sat 21 Nov, **08:30**, sir.",
    );
  });
});

describe("4. Notes are appended, never overwritten (task 11: the first podcast link was lost)", () => {
  const first = "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi";
  const second = "https://www.youtube.com/watch?v=Ch4Sl0POBhU (Caleb Ralston, How to Build a Personal Brand, 6h 22min)";
  it("keeps the old notes and adds the new", () => {
    expect(mergeNotes(first, second)).toBe(`${first}\n${second}`);
    expect(mergeNotes(null, second)).toBe(second);
    // Nothing new, or the model already kept everything: no duplicate.
    expect(mergeNotes(`${first}\n${second}`, second)).toBe(`${first}\n${second}`);
    expect(mergeNotes(first, `${first}\n${second}`)).toBe(`${first}\n${second}`);
  });
});

describe("4. Change history and /undo", () => {
  const before = { id: 11, title: "Watch podcast and take notes", notes: "https://youtu.be/SaiTtbRJwic", due_at: at("2026-11-21T14:00").toISOString(), status: "todo", kind: null };
  const moved: HistoryEntry = {
    id: 7,
    task_id: 11,
    action: "update",
    before,
    after: { ...before, due_at: at("2026-11-23T10:00").toISOString(), notes: "https://youtu.be/SaiTtbRJwic\nhttps://www.youtube.com/watch?v=Ch4Sl0POBhU" },
    created_at: at("2026-11-20T23:08").toISOString(),
    undone_at: null,
  };
  it("says what changed in his words", () => {
    expect(describeChange(moved, at("2026-11-20T23:10"))).toBe("**Watch podcast and take notes**: moved from Sat 21 Nov 14:00 to Mon 23 Nov 10:00; notes changed");
    expect(describeChange({ ...moved, action: "insert", before: null, after: before }, at("2026-11-20T23:10"))).toBe("**Watch podcast and take notes**: added");
    expect(describeChange({ ...moved, after: { ...before, status: "dropped" } }, at("2026-11-20T23:10"))).toBe("**Watch podcast and take notes**: removed");
  });
  it("undo puts back exactly what that change changed", () => {
    expect(undoPatch(moved)).toEqual({ due_at: before.due_at, notes: before.notes });
    expect(undoPatch({ ...moved, action: "insert", before: null, after: before })).toEqual({ status: "dropped" });
    expect(undoPatch({ ...moved, after: { ...before, status: "done", completed_at: "2026-11-20T18:00:00Z" } })).toEqual({ status: "todo", completed_at: null });
  });
});

describe("5. Receipts show what is attached", () => {
  it("'✓ Watch: <title> → Mon 23 Nov, 10:00 · 🔗 link · 🖼 1 photo'", () => {
    expect(savedMarks({ link: true, media: { photo: 1, video: 0, file: 0 } })).toBe(" · 🔗 link · 🖼 1 photo");
    expect(savedMarks({ media: { photo: 2, video: 1, file: 1 } })).toBe(" · 🖼 2 photos · 🎞 1 video · 📎 1 file");
    expect(
      confirmationFor([{ tool: "add_task", title: "Watch: Instagram Masterclass", status: "todo", due_at: at("2026-11-23T10:00").toISOString(), link: true, media: { photo: 1, video: 0, file: 0 } }], at("2026-11-20T23:25")),
    ).toBe("✓ **Watch: Instagram Masterclass** → Mon 23 Nov, **10:00** · 🔗 link · 🖼 1 photo, sir.");
  });
});

describe("1. Never claim a send that did not happen (15:41, 22:39: 'Here it is, sir, the picture' with no picture)", () => {
  it("drops the claim and keeps the rest", () => {
    expect(withoutSendClaims("Here it is, sir, the picture about adding a feature to your website.")).toBe("");
    expect(withoutSendClaims("Here it is, sir, with the image attached. Anything else for the website?")).toBe("Anything else for the website?");
  });
});

describe("9. Memory: only facts he stated", () => {
  const his = "Also, Tony, remind me my prayer times. Always. Okay? Take into account my location. It's Chorazm Honka.";
  it("rejects what he never said (row 3: 'Lives in Khorezm (Khiva area)')", () => {
    expect(statedByHim("Lives in Khorezm (Khiva area); prayer times should follow that location.", his)).toBe(false);
  });
  it("keeps what he said, in other words", () => {
    expect(statedByHim("Lives in Chorazm Honka; prayer times follow that location", his)).toBe(true);
    expect(statedByHim("Works out in the evenings", "I work out in the evenings, remember that")).toBe(true);
  });
  it("rejects Tony's own words (row 7: Caleb Ralston's course summary)", () => {
    expect(statedByHim("Caleb Ralston's 6 h 22 min course is about building a personal brand", "it is the podcast which i should wtch the one i told")).toBe(false);
  });
});

describe("10. Never mention tools, filters or internal errors (22:38)", () => {
  it("drops the sentences about his machinery", () => {
    expect(withoutInternals("I can't clean the chat, sir; I have no tool for deleting messages, but you can clear it from Telegram's menu.")).toBe("");
    expect(withoutInternals("The overdue filter came back empty, though my list shows these five from today as unfinished:\n- [ ] Challenge")).toBe("- [ ] Challenge");
    expect(withoutInternals("Two items today, sir: the club at 18:00 and reading at 21:00.")).toBe("Two items today, sir: the club at 18:00 and reading at 21:00.");
    // Talking about his own agent's prompt is conversation, not machinery.
    expect(withoutInternals("For your agent, keep the system prompt short and give it examples.")).toBe("For your agent, keep the system prompt short and give it examples.");
  });
});

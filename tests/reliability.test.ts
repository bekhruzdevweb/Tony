/**
 * The reliability rules, each on the real message that broke it (his chat, 19–20 Nov).
 */
import { describe, expect, it } from "vitest";
import {
  allowedLanguage,
  asksForTime,
  bestTranscript,
  claimsAction,
  givenTimes,
  heldToGivenTime,
  isCapture,
  linksIn,
  notesToKeep,
  oneQuestion,
  splitIntents,
  unsaved,
  withoutClaims,
} from "../src/lib/brain/reliability";

const at = (local: string) => new Date(`${local}:00+05:00`);
const hhmm = (date: Date) => new Date(date.getTime() + 5 * 60 * 60_000).toISOString().slice(11, 16);

describe("2. Several requests in one message", () => {
  it("splits on 'And also' (17:31: the second request was dropped)", () => {
    expect(splitIntents("Can you remind this one after 20 minutes? And also, tomorrow remind me to call the barber at 8.30 a.m. in the morning.")).toEqual([
      "Can you remind this one after 20 minutes?",
      "tomorrow remind me to call the barber at 8.30 a.m. in the morning.",
    ]);
  });
  it("splits on a sentence starting 'Also' (22:36)", () => {
    expect(splitIntents("Tomorrow: presentation at 13:00 and the Zoom tutorial at 18:00. Also move IELTS prep to 10:00.")).toEqual([
      "Tomorrow: presentation at 13:00 and the Zoom tutorial at 18:00.",
      "move IELTS prep to 10:00.",
    ]);
  });
  it("splits 'clean the chat and send me the overdue task' (22:38)", () => {
    expect(splitIntents("Can you clean the chat and send me the overdue task which I could not complete today?")).toEqual([
      "Can you clean the chat",
      "send me the overdue task which I could not complete today?",
    ]);
  });
  it("splits '… and also remind me to …' (22:32)", () => {
    const parts = splitIntents(
      "also can you remind me to make a presentation for english file elementary for international students tomorrow and also remind me to shoot a tutorial of how to use my vocabulary learning app on a zoom for tomorrow",
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("for international students tomorrow");
    expect(parts[1]).toMatch(/^remind me to shoot a tutorial/);
  });
  it("keeps one request whole", () => {
    expect(splitIntents("Tomorrow I have to call my barber at 7 AM. Remind me one hour before.")).toHaveLength(1);
    expect(splitIntents("remind me to call mum and send her flowers")).toHaveLength(1);
    expect(splitIntents("I have to send a message at 1, 1 and a half p.m. to the one teacher on Instagram.")).toHaveLength(1);
    expect(splitIntents("Okay, schedule few tasks for tomorrow. Preparation for IELTS exam and posting stories and posting reel on Instagram.")).toHaveLength(1);
  });
});

describe("6. The times he gave are final", () => {
  const now = at("2026-11-20T17:31");
  it("reads clock times and moments from now", () => {
    expect(givenTimes("tomorrow remind me to call the barber at 8.30 a.m. in the morning", now)).toEqual([{ minutes: [8 * 60 + 30] }]);
    expect(givenTimes("I have to conduct the lesson at 6.30 p.m.", now)).toEqual([{ minutes: [18 * 60 + 30] }]);
    expect(givenTimes("Tomorrow I have to call my barber at 7 AM.", now)).toEqual([{ minutes: [7 * 60] }]);
    expect(givenTimes("remind me to work out at 6", now)).toEqual([{ minutes: [6 * 60, 18 * 60] }]);
    expect(givenTimes("read 15 pages at 9 a.m.", now)).toEqual([{ minutes: [9 * 60] }]);
    expect(hhmm((givenTimes("remind me to prepare for my lesson after half an hour", now)[0] as { at: Date }).at)).toBe("18:01");
    expect(hhmm((givenTimes("remind me after three hours to add pull-ups", now)[0] as { at: Date }).at)).toBe("20:31");
  });
  it("puts his time back when the model chose another", () => {
    // 22:28: "remind me tomorrow afternoon" has no clock time: nothing to hold to.
    expect(heldToGivenTime(at("2026-11-21T15:00"), "remind me tomorrow at the afternoon", now)).toBeUndefined();
    expect(hhmm(heldToGivenTime(at("2026-11-21T09:00"), "tomorrow call the barber at 8.30 a.m.", now)!)).toBe("08:30");
    expect(heldToGivenTime(at("2026-11-21T08:30"), "tomorrow call the barber at 8.30 a.m.", now)).toBeUndefined();
    expect(hhmm(heldToGivenTime(at("2026-11-20T18:31"), "remind me to prepare for my lesson after half an hour", now)!)).toBe("18:01");
    // Two times: not settled by code.
    expect(heldToGivenTime(at("2026-11-20T13:00"), "at 1, 1 and a half p.m.", now)).toBeUndefined();
    // "At 6" with 18:00 chosen is right.
    expect(heldToGivenTime(at("2026-11-21T18:00"), "work out at 6", now)).toBeUndefined();
  });
});

describe("6. Act first, at most one question", () => {
  it("keeps only the first question", () => {
    expect(oneQuestion("Both for tomorrow, sir. What time should I set? Or shall I plan them?")).toBe("Both for tomorrow, sir. What time should I set?");
  });
  it("spots a request for a time instead of saving (20 Nov 00:00, 22:32)", () => {
    expect(asksForTime("Sir, at what times tomorrow would you like each task scheduled?")).toBe(true);
    expect(asksForTime("Both for tomorrow, sir: the presentation and the Zoom tutorial. What time should I set?")).toBe(true);
    expect(asksForTime("Shall I drop it?")).toBe(false);
  });
  it("tells a capture from a question to Tony", () => {
    expect(isCapture("Tony, also remind me to add bodyweight exercise to my workout plan.")).toBe(true);
    expect(isCapture("I have to update my fitness app by adding new features")).toBe(true);
    expect(isCapture("what can u do")).toBe(false);
    expect(isCapture("Can you show me today's schedule?")).toBe(false);
  });
});

describe("1. Replies only from verified results", () => {
  it("spots claims the model made without a write (17:32, 22:48)", () => {
    expect(claimsAction("Noted, sir. Barber reminder set for tomorrow, Saturday 21 November, at **08:30**.")).toBe(true);
    expect(claimsAction("Corrected, sir: the **13:00** presentation now notes English File Elementary.")).toBe(true);
    expect(claimsAction("Stories at 12:00 tomorrow now carry three points in the notes.")).toBe(true);
    expect(claimsAction("I haven't saved anything.")).toBe(false);
    expect(claimsAction("Two items today, sir: the club at 18:00 and reading at 21:00.")).toBe(false);
  });
  it("drops the claiming sentences and keeps the rest", () => {
    expect(withoutClaims("Noted, sir. Barber reminder set for 08:30. Anything else?")).toBe("Anything else?");
  });
  it("finds fields that did not stick", () => {
    expect(unsaved({ notes: "Elementary", due_at: "2026-11-21T08:00:00+00:00" }, { notes: "Elementary", due_at: "2026-11-21T08:00:00.000Z" })).toEqual([]);
    expect(unsaved({ notes: null, due_at: "2026-11-21T08:00:00Z" }, { notes: "for the New York student" })).toEqual(["notes"]);
    expect(unsaved({ status: "todo" }, { status: "dropped" })).toEqual(["status"]);
  });
});

describe("4. Every link and detail from the first message", () => {
  it("keeps the podcast link (20 Nov 00:59, lost)", () => {
    const said = "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi tmr remind me to watch this podcast and take notes at 2 p.m";
    expect(linksIn(said)).toEqual(["https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi"]);
    expect(notesToKeep(said, [{ title: "Watch podcast and take notes", notes: null }])).toBe("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi");
    expect(notesToKeep(said, [{ title: "Watch podcast and take notes", notes: "https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi" }])).toBeUndefined();
  });
  it("keeps his words when details were dropped (22:46: 'for the student from New York', 'elementary')", () => {
    const said = "Make a presentation for the English File elementary book for the student from New York";
    expect(notesToKeep(said, [{ title: "Make a presentation", notes: null }])).toBe(`From your message: "${said}"`);
    expect(notesToKeep(said, [{ title: "English File Elementary presentation", notes: "For the student from New York" }])).toBeUndefined();
  });
  it("his instructions to Tony are not details (23:17: 'put thist task to inbox and remind me if i dont check it for 2 days')", () => {
    expect(notesToKeep("Zamokli ko'ynak olish .put thist task to inbox and remind me if i dont check it for 2 days", [{ title: "Buy a zippered shirt", notes: "Zamokli ko'ynak olish" }])).toBeUndefined();
  });
  it("counts parts as kept (stories about the app, the club and the grammar series)", () => {
    const said = "post stories about the new app I'm building, the upcoming speaking club and the grammar series";
    expect(notesToKeep(said, [{ title: "Post stories", notes: null, parts: ["the new app he's building", "the upcoming speaking club", "the grammar series"] }])).toBeUndefined();
  });
});

describe("5. Voice notes in English, Uzbek or Russian (22:57: read as Hungarian)", () => {
  it("allows only en, uz, ru", () => {
    expect(allowedLanguage("English")).toBe("en");
    expect(allowedLanguage("uz")).toBe("uz");
    expect(allowedLanguage("russian")).toBe("ru");
    expect(allowedLanguage("hungarian")).toBeUndefined();
    expect(allowedLanguage("hu")).toBeUndefined();
  });
  it("keeps the most confident reading", () => {
    expect(
      bestTranscript([
        { language: "en", text: "I said also tell me which podcast I have to watch.", logprob: -0.21 },
        { language: "ru", text: "Ай сэд олсо", logprob: -1.4 },
        { language: "uz", text: "", logprob: -0.1 },
      ])?.text,
    ).toBe("I said also tell me which podcast I have to watch.");
  });
});

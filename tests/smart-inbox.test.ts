import { describe, expect, it } from "vitest";
import { firstFreeDay, fullNote, startDate, wantsSuggestion } from "../src/lib/smart-inbox-rules";
import { answersYes } from "../src/lib/brain/tools";
import { joinedSay } from "../src/lib/slots";
import { fileGist } from "../src/lib/media";

const at = (local: string) => new Date(`${local}:00+05:00`);

describe("smart inbox rules (Phase I)", () => {
  it("starts today, tomorrow after 20:00, and the coming morning after midnight", () => {
    expect(startDate(at("2026-11-23T10:00"))).toBe("2026-11-23");
    expect(startDate(at("2026-11-23T21:00"))).toBe("2026-11-24");
    expect(startDate(at("2026-11-23T04:12"))).toBe("2026-11-23");
  });
  it("passes full days and names them", () => {
    const loads = new Map([["2026-11-23", 12], ["2026-11-24", 7], ["2026-11-25", 2]]);
    expect(firstFreeDay("2026-11-23", loads, 14)).toEqual({ day: "2026-11-25", skipped: ["2026-11-23", "2026-11-24"] });
    expect(fullNote(["2026-11-23", "2026-11-24"], at("2026-11-23T10:00"))).toBe("Mon 23 Nov and Tue 24 Nov are full.");
    expect(fullNote(["2026-11-23"], at("2026-11-23T10:00"))).toBe("Mon 23 Nov is full.");
  });
  it("leaves it unplanned when he says so", () => {
    expect(wantsSuggestion("I want to shoot videos like this")).toBe(true);
    expect(wantsSuggestion("put it in the inbox")).toBe(false);
    expect(wantsSuggestion("someday I'll read this")).toBe(false);
  });
});

describe("a yes is a yes", () => {
  it("runs a proposal when he answers Tony's question with yes", () => {
    expect(answersYes("Yes, remove them all", "Remove all 13 sessions?")).toBe(true);
    expect(answersYes("ha", "Shall I drop it?")).toBe(true);
    expect(answersYes("yes but not the mock", "Remove all 13 sessions?")).toBe(false);
    expect(answersYes("yes", "Done, sir.")).toBe(false);
    expect(answersYes("remove the gym task", "Anything else?")).toBe(false);
  });
  it("joins proposals that share their verb", () => {
    expect(joinedSay(["I'll drop **A**.", "I'll drop **B**."])).toBe("I'll drop these 2: **A** and **B**.");
    expect(joinedSay(["I'll drop **A**.", "I'll move **B**."])).toBe("I'll drop **A**.\nI'll move **B**.");
  });
});

describe("a kept file in a few words", () => {
  it("names a PDF by its summary and a video by his caption", () => {
    expect(fileGist({ kind: "document", note: null, caption: null, description: "Summary: This document is an 8-week IELTS Academic study plan (23 November…)" })).toBe("file: an 8-week IELTS Academic study plan");
    expect(fileGist({ kind: "video", note: null, caption: "this is how i should be uploading stories daily", description: null })).toBe("video: this is how i should be uploading stories daily");
  });
});

describe("a silent video is not given words", async () => {
  const { inventedSpeech } = await import("../src/lib/voice");
  it("drops the transcriber's stock phrases", () => {
    expect(inventedSpeech("Субтитры сделал DimaTorzok")).toBe(true);
    expect(inventedSpeech("Thank you for watching!")).toBe(true);
    expect(inventedSpeech("Today I'll show you how I post stories every day")).toBe(false);
  });
});

describe("each line on its own line (23 Nov 04:21)", async () => {
  const { keepLines } = await import("../src/lib/rich");
  it("keeps receipt lines and a question apart, tables and lists together", () => {
    expect(keepLines("**Make my own IELTS plan**\nWhen today, Mon 23 Nov? Only **10:45** is free.")).toBe("**Make my own IELTS plan**\n\nWhen today, Mon 23 Nov? Only **10:45** is free.");
    expect(keepLines("✓ 2 set:\n- **A** → 18:00\n- **B** → 19:00\n🔁 weekly")).toBe("✓ 2 set:\n\n- **A** → 18:00\n- **B** → 19:00\n\n🔁 weekly");
    expect(keepLines("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
  });
});

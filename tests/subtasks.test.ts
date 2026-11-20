import { describe, expect, it } from "vitest";
import { allDone, listFromNotes, progress } from "../src/lib/subtask-rules";
import { confirmationFor } from "../src/lib/brain/checks";

describe("Lists in notes become subtasks (task 7, 20 Nov)", () => {
  it("reads task 7's inline list", () => {
    const { parts, rest } = listFromNotes("Stories to cover: 1) the new app he's building, 2) the upcoming speaking club, 3) the grammar series.");
    expect(parts).toEqual(["the new app he's building", "the upcoming speaking club", "the grammar series"]);
    expect(rest).toBe("Stories to cover");
  });
  it("reads a list written line by line, keeping the other notes", () => {
    const { parts, rest } = listFromNotes("For the Monday class\n- slides\n- examples\n- quiz");
    expect(parts).toEqual(["slides", "examples", "quiz"]);
    expect(rest).toBe("For the Monday class");
  });
  it("leaves ordinary notes alone", () => {
    expect(listFromNotes("https://youtu.be/SaiTtbRJwic").parts).toEqual([]);
    expect(listFromNotes("Confirm the 10:00 slot with Dilnoza").parts).toEqual([]);
    expect(listFromNotes("- just one thing").parts).toEqual([]);
  });
});

describe("Progress", () => {
  it('reads "0/3" and "2/3"', () => {
    expect(progress([{ done: false }, { done: false }, { done: false }])).toBe("0/3");
    expect(progress([{ done: true }, { done: true }, { done: false }])).toBe("2/3");
  });
  it("asks about the parent only when every part is done", () => {
    expect(allDone([{ done: true }, { done: true }])).toBe(true);
    expect(allDone([{ done: true }, { done: false }])).toBe(false);
    expect(allDone([])).toBe(false);
  });
});

describe("Confirmations", () => {
  const now = new Date("2026-11-20T18:00:00Z");
  it("says how far along the parts are after ticking one", () => {
    expect(confirmationFor([{ tool: "subtask", title: "Presentation", status: "todo", due_at: null, parts: "1/3" }], now)).toBe("☑ **Presentation**: 1/3 parts done");
  });
  it("shows the parts count on a new task", () => {
    expect(confirmationFor([{ tool: "add_task", title: "Post stories", status: "inbox", due_at: null, parts: "0/3" }], now)).toBe("✓ **Post stories** in the inbox · 0/3 parts");
  });
});

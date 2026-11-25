import { describe, expect, it } from "vitest";
import { big3Done, big3For } from "../src/lib/big3-rules";

const localDateOf = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 10);

describe("the Big 3", () => {
  it("lists a day's chosen tasks, open ones first, and leaves out other days and dropped tasks", () => {
    const tasks = [
      { id: 1, status: "done", big3_on: "2026-11-25" },
      { id: 2, status: "todo", big3_on: "2026-11-25" },
      { id: 3, status: "todo", big3_on: "2026-11-26" },
      { id: 4, status: "dropped", big3_on: "2026-11-25" },
      { id: 5, status: "inbox", big3_on: null },
    ];
    expect(big3For(tasks, "2026-11-25").map((task) => task.id)).toEqual([2, 1]);
  });
  it("a repeating task finished on its day counts as done even though it is open again for next week", () => {
    expect(big3Done({ id: 1, status: "todo", completed_at: "2026-11-25T13:30:00Z" }, "2026-11-25", localDateOf)).toBe(true);
    expect(big3Done({ id: 1, status: "todo", completed_at: "2026-11-24T13:30:00Z" }, "2026-11-25", localDateOf)).toBe(false);
    expect(big3Done({ id: 1, status: "done" }, "2026-11-25", localDateOf)).toBe(true);
  });
});

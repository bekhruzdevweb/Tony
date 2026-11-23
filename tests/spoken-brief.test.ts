/**
 * The morning brief said aloud names his tasks as he knows them (23 Nov 08:00).
 */
import { describe, expect, it } from "vitest";
import { spokenBrief } from "../src/lib/briefs";
import type { Task } from "../src/lib/tasks";

const at = (local: string) => new Date(`${local}:00+05:00`).toISOString();
const task = (title: string, due: string | null, extra: Partial<Task> = {}) => ({ id: 1, title, due_at: due ? at(due) : null, status: "todo", ...extra }) as Task;

describe("the spoken brief", () => {
  it("'Watch: Instagram Masterclass (Brock Johnson)' is said with its name, not as 'Watch' (23 Nov: 'then Watch at 10:00')", () => {
    const open = [task("Post on YouTube", "2026-11-23T09:00"), task("Watch: Instagram Masterclass (Brock Johnson)", "2026-11-23T10:00")];
    const words = spokenBrief(open, 2, undefined, "Asia/Tashkent");
    expect(words).toBe("Good morning, sir. 2 tasks today, starting with Post on YouTube at 09:00, then Watch Instagram Masterclass at 10:00. 2 items are carried over.");
  });

  it("a task with no time is named without one (its 20:00 is only the day's last check)", () => {
    const open = [task("Make my own IELTS plan", "2026-11-23T20:00", { anytime: true })];
    expect(spokenBrief(open, 0, undefined, "Asia/Tashkent")).toBe("Good morning, sir. One task today: Make my own IELTS plan.");
  });
});

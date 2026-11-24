import { describe, expect, it } from "vitest";
import { hourRange, layoutDay } from "../src/lib/day-calendar";
import type { Task } from "../src/lib/tasks";

const task = (id: number, clock: string, more: Partial<Task> = {}) =>
  ({ id, title: `Task ${id}`, status: "todo", priority: 4, due_at: `2026-11-24T${clock}:00+05:00`, ...more }) as Task;

describe("the day calendar", () => {
  it("puts tasks that overlap side by side and leaves the others full width", () => {
    const { blocks } = layoutDay([task(1, "09:00", { duration_minutes: 60 }), task(2, "09:30", { duration_minutes: 30 }), task(3, "11:00")], "2026-11-24");
    expect(blocks.map((block) => [block.task.id, block.column, block.columns])).toEqual([
      [1, 0, 2],
      [2, 1, 2],
      [3, 0, 1],
    ]);
  });

  it("keeps no-time tasks, prayers and other days off the timeline", () => {
    const day = layoutDay(
      [task(1, "20:00", { anytime: true }), task(2, "12:44", { kind: "prayer" }), task(3, "10:00"), task(4, "10:00", { status: "dropped" }), { ...task(5, "10:00"), due_at: "2026-11-25T10:00:00+05:00" }],
      "2026-11-24",
    );
    expect(day.blocks.map((block) => block.task.id)).toEqual([3]);
    expect(day.anytime.map((t) => t.id)).toEqual([1]);
    expect(day.prayers.map((t) => t.id)).toEqual([2]);
  });

  it("shows his waking day and widens for an early task", () => {
    expect(hourRange(layoutDay([task(1, "10:00")], "2026-11-24").blocks, [])).toEqual({ from: 7, to: 23 });
    expect(hourRange(layoutDay([task(1, "05:30"), task(2, "23:30", { duration_minutes: 60 })], "2026-11-24").blocks, [])).toEqual({ from: 5, to: 24 });
  });
});

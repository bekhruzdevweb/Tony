/**
 * Phase H's two new app screens render with real-shaped data: the Habits
 * screen (a habit's two weeks and its check-in) and the Plan board's lanes.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppState } from "../src/lib/app-types";
import { HabitsScreen } from "../src/components/app/screens";
import type { Task } from "../src/lib/tasks";

const now = new Date("2026-11-22T08:30:00Z");
const base = { notes: null, project_id: null, priority: 4, persistent: false, persistent_schedule: null, repeat_rule: null, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z", completed_at: null } as const;
const task = (id: number, title: string, extra: Partial<Task>): Task => ({ ...base, id, title, status: extra.due_at ? "todo" : "inbox", due_at: null, ...extra });
const state = {
  now: now.toISOString(),
  tasks: [
    task(46, "Call barber", { due_at: "2026-11-22T11:00:00Z", duration_minutes: 10 }),
    task(64, "IELTS: Writing Task 2 (learn) + Speaking Part 3", { due_at: "2026-11-23T04:00:00Z", repeat_rule: "weekly", repeat_until: "2027-01-10", tags: ["ielts"] }),
    task(33, "Buy a zippered shirt", {}),
    task(51, "Study Thinking Fast and Slow", { free_time: true }),
    task(90, "Reading", { due_at: "2026-11-22T16:00:00Z", repeat_rule: "daily", habit: true }),
  ],
  projects: [],
  memory: [],
  messages: [],
  plans: [],
  media: [],
  subtasks: [],
  habits: [
    {
      task_id: 90,
      title: "Reading",
      at: "21:00",
      rule: "daily",
      streak: 3,
      best: 5,
      dueToday: true,
      doneToday: false,
      line: "🔥 3 days in a row: keep it going",
      recent: Array.from({ length: 14 }, (_, n) => ({ day: `2026-11-${String(9 + n).padStart(2, "0")}`, state: n === 13 ? ("due" as const) : n % 4 === 0 ? ("missed" as const) : ("done" as const) })),
    },
  ],
  progress: [{ name: "IELTS", done: 1, due: 2, skipped: 0, sessions: 7 }],
  settings: { brief_morning: "08:00", brief_evening: "21:00", quiet_start: "23:00", quiet_end: "07:00", persistent_schedule: [0, 15] },
  status: { telegram: true, database: true, brain: true, clock: true, lastTick: null, model: "x", voiceModel: "y", botUsername: "Tonynrlbot" },
} as AppState;

describe("Phase H screens", () => {
  it("Habits: the run, the two weeks, today's check-in, and the plans' progress", () => {
    const html = renderToString(createElement(HabitsScreen, { state, onCheck: () => undefined }));
    expect(html).toContain("Reading");
    expect(html).toContain(">3</p>");
    // No flame: he asked for the emoji to go (25 Nov).
    expect(html).not.toContain("🔥");
    expect(html).toContain("✓ Done today");
    expect(html).toContain("IELTS");
    expect((html.match(/aspect-square/g) ?? []).length).toBe(14);
  });
});

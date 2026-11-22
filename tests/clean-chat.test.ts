/**
 * 22 Nov 12:37, his twelve screenshots: the pure rules behind the fixes.
 * Lists that can really be ticked, clashes as one line per group, the task
 * "this" means, and which tasks a follow-up's buttons are about.
 */
import { describe, expect, it } from "vitest";
import { clashGroups, clashLinesFor, recentReminderNote, type TimedTask } from "../src/lib/brain/checks";
import { flipTick, hasTaskList, taskOfLine, tickButton, withoutTicks, withTicks } from "../src/lib/list-ticks";
import { markdownToHtml } from "../src/lib/rich";
import { tasksOfRows } from "../src/lib/smart-jobs";

const at = (local: string) => new Date(`${local}:00+05:00`);

// His open tasks on 22 Nov, as the list reply named them.
const open = [
  { id: 13, title: "Challenge: post 4 images, then a story" },
  { id: 22, title: "Develop the website" },
  { id: 46, title: "Call barber" },
  { id: 55, title: "Start IELTS exam preparation" },
  { id: 65, title: "IELTS: Reading + Listening (learn)" },
  { id: 67, title: "IELTS: Reading (master + mix) + Listening (timed)" },
  { id: 35, title: "Launch beginner and elementary course" },
];

describe('"why i can\'t tick the tasks to complete??" (12:28 list reply)', () => {
  it("a line naming one of his open tasks gets ✓ Done at its end; anything else becomes a plain bullet, never a box that does nothing", () => {
    const reply = [
      "### Overdue",
      "- [ ] Challenge: post 4 images, then a story (was Fri 20 Nov, 08:00)",
      "- [ ] Develop the website (was Fri 20 Nov, 18:00)",
      "### Today",
      "- [ ] **Start IELTS exam preparation** at **20:15**",
      "  - [ ] Get your books ready",
      "- [x] Message teacher about launching group",
    ].join("\n");
    expect(hasTaskList(reply)).toBe(true);
    const { markdown, ticked } = withTicks(reply, open);
    expect(ticked).toEqual([13, 22, 55]);
    expect(markdown.split("\n")).toEqual([
      "### Overdue",
      `- [ ] Challenge: post 4 images, then a story (was Fri 20 Nov, 08:00) ${tickButton(13)}`,
      `- [ ] Develop the website (was Fri 20 Nov, 18:00) ${tickButton(22)}`,
      "### Today",
      `- [ ] **Start IELTS exam preparation** at **20:15** ${tickButton(55)}`,
      // A step inside a task is not a task of his: a bullet.
      "  - Get your books ready",
      // Already done: shown as written.
      "- [x] Message teacher about launching group",
    ]);
    expect(tickButton(55)).toBe('<tg-button type="callback_data" style="link" data="lt:55">✓ Done</tg-button>');
  });

  it("a title shortened in the line is still found when only one task fits; two that fit equally get no button", () => {
    expect(taskOfLine("Tue 24: IELTS Reading + Listening (**09:00**)", open)).toBe(65);
    expect(taskOfLine("Call the barber at 14:00", open)).toBe(46);
    expect(taskOfLine("IELTS Reading and Listening", [open[4], { id: 99, title: "IELTS: Reading + Listening (timed)" }])).toBeUndefined();
    expect(taskOfLine("Buy a notebook", open)).toBeUndefined();
  });

  it("✓ Done ticks that line and offers ↩ Undo; ↩ Undo puts it back; other lines are untouched", () => {
    const { markdown } = withTicks("- [ ] Call barber at **14:00**\n- [ ] Develop the website", open);
    const done = flipTick(markdown, 46, true);
    expect(done.split("\n")[0]).toBe(`- [x] ~~Call barber at **14:00**~~ ${tickButton(46, "↩ Undo")}`);
    expect(done.split("\n")[1]).toBe(markdown.split("\n")[1]);
    expect(flipTick(done, 46, false)).toBe(markdown);
  });

  it("without the buttons (Telegram refused them), and as plain HTML, the reply reads the same with no tags showing", () => {
    const { markdown } = withTicks("- [ ] Call barber", open);
    expect(withoutTicks(markdown)).toBe("- [ ] Call barber");
    expect(markdownToHtml(markdown)).toBe("☐ Call barber");
  });
});

describe("the brief's clashes: one line per group, three at most (22 Nov: six clash lines)", () => {
  const timed = (id: number, title: string, local: string): TimedTask => ({ id, title, due_at: at(local).toISOString(), status: "todo", duration_minutes: 30 });
  const day = [
    timed(1, "Plan new chatbot agent features", "2026-11-22T13:00"),
    timed(2, "Post stories in this format", "2026-11-22T13:00"),
    timed(3, "Posting stories on Instagram", "2026-11-22T20:15"),
    timed(4, "Instagram reel (saved link)", "2026-11-22T20:15"),
    timed(5, "Start IELTS exam preparation", "2026-11-22T20:15"),
    timed(6, "Call barber", "2026-11-22T14:00"),
  ];
  it("three tasks at 20:15 are one line, not three pairs", () => {
    expect(clashGroups(day).map((group) => group.map((task) => task.id))).toEqual([[1, 2], [3, 4, 5]]);
    expect(clashLinesFor(day)).toEqual([
      "Clash: Plan new chatbot agent features and Post stories in this format are both at 13:00",
      "Clash: Posting stories on Instagram, Instagram reel (saved link) and Start IELTS exam preparation are all at 20:15",
    ]);
  });
  it("more than three groups: the rest are counted, not listed", () => {
    const many = [10, 12, 14, 16, 18].flatMap((hour, n) => [timed(100 + n * 2, `Task ${n}a`, `2026-11-22T${hour}:00`), timed(101 + n * 2, `Task ${n}b`, `2026-11-22T${hour}:00`)]);
    const lines = clashLinesFor(many);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("…and 2 more clashes later today");
  });
});

describe('"this task" is the one touched last (22 Nov 12:14: the Freya\'s Talking posts, not the 12:00 video)', () => {
  it("the task he started at 12:14 wins over the 12:00 reminder, which is named as not the one", () => {
    const note = recentReminderNote(
      [
        { task_id: 50, title: "Watch saved video", sent_at: at("2026-11-22T12:00").toISOString(), how: "reminded" },
        { task_id: 49, title: "Write Telegram posts like Freya's Talking", sent_at: at("2026-11-22T12:14").toISOString(), how: "started" },
      ],
      at("2026-11-22T12:14"),
    )!;
    expect(note).toContain('He started task #49 "Write Telegram posts like Freya\'s Talking" at 12:14 with your button: that is the task in focus.');
    expect(note).toContain('he means #49.');
    expect(note).toContain('Your 12:00 message about #50 "Watch saved video" came before that: it is not the one.');
  });
  it("a reminder alone keeps its old meaning", () => {
    const note = recentReminderNote([{ task_id: 30, title: "Prepare for the lesson", sent_at: at("2026-11-20T17:30").toISOString() }], at("2026-11-20T17:31"))!;
    expect(note).toContain('You reminded him about task #30 "Prepare for the lesson" at 17:30');
    expect(note).not.toContain("not the one");
  });
});

describe("a follow-up knows its tasks, so it goes once they are settled", () => {
  it("reads the tasks from its buttons", () => {
    expect(
      tasksOfRows([
        [
          { text: "✓ 1", data: "fu:done:43" },
          { text: "📅 1", data: "fu:tom:43" },
        ],
        [{ text: "📅 All to tomorrow", data: "fu:all:43,11" }],
        [{ text: "▶️ Do it now", data: "ft:now:49" }, { text: "📋 Show list", data: "ft:list:0" }],
        [{ text: "Open", data: "url:https://example.com" }],
      ]),
    ).toEqual([43, 11, 49]);
  });
});

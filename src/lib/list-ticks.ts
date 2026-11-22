import type { Task } from "./tasks";

/**
 * Task lists in Tony's replies that can be ticked off.
 *
 * A reply is shown as a Telegram rich message, where "- [ ] Title" draws a
 * native checkbox. A tap on that box is never reported to the bot, so it
 * looked tickable and did nothing ("why i can't tick the tasks to
 * complete??", 22 Nov). So each line that names one of his open tasks gets
 * a "✓ Done" button at its end, as on the pinned Today board; a tap is
 * handled in plain code ("lt:<task>") and the line is redrawn ticked, with
 * "↩ Undo". A box that names no task of his becomes a plain bullet: nothing
 * in the chat looks tickable unless a tap really ticks it.
 */
export const LIST_TICK = "lt:";

const TASK_ITEM = /^(\s*[-*+]\s+)\[( |x|X)\]\s+(.*)$/;
const BUTTON = /\s*<tg-button type="callback_data" style="link" data="lt:(\d+)">[^<]*<\/tg-button>\s*$/;
const STOP = new Set(["the", "a", "an", "and", "my", "to", "of", "for", "on", "in", "with", "at", "from", "your", "this", "that"]);

const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (text: string) => normal(text).split(" ").filter((word) => word.length >= 2 && !STOP.has(word));

export const tickButton = (taskId: number, label = "✓ Done") => `<tg-button type="callback_data" style="link" data="${LIST_TICK}${taskId}">${label}</tg-button>`;

/**
 * The task a list line names: a title written out in full (the longest such
 * title wins), or else the one title most of whose words are in the line
 * ("IELTS Reading + Listening (09:00)" for "IELTS: Reading + Listening (learn)").
 */
export function taskOfLine(line: string, tasks: Pick<Task, "id" | "title">[]): number | undefined {
  const text = ` ${normal(line)} `;
  const whole = tasks.filter((task) => normal(task.title).length >= 3 && text.includes(` ${normal(task.title)} `)).sort((x, y) => y.title.length - x.title.length);
  if (whole.length > 0) return whole[0].id;
  const lineWords = new Set(words(line));
  const scored = tasks
    .map((task) => {
      const own = words(task.title);
      const shared = own.filter((word) => lineWords.has(word)).length;
      return { id: task.id, shared, share: own.length ? shared / own.length : 0 };
    })
    .filter((row) => row.shared >= 2 && row.share >= 0.6)
    .sort((x, y) => y.share - x.share || y.shared - x.shared);
  // Two titles fit as well as each other: not sure which, so no button.
  if (scored.length === 0 || (scored[1] && scored[1].share === scored[0].share && scored[1].shared === scored[0].shared)) return undefined;
  return scored[0].id;
}

/** Whether a reply holds a task list at all (so the open tasks are only looked up when needed). */
export const hasTaskList = (markdown: string) => markdown.split("\n").some((line) => TASK_ITEM.test(line));

/** The reply with a "✓ Done" on each line that names an open task, and plain bullets for the rest. */
export function withTicks(markdown: string, tasks: Pick<Task, "id" | "title">[]): { markdown: string; ticked: number[] } {
  const ticked: number[] = [];
  const lines = markdown.split("\n").map((line) => {
    const item = TASK_ITEM.exec(line);
    if (!item) return line;
    const [, lead, mark, rest] = item;
    // Already done in his list: shown as done, nothing to tap.
    if (mark !== " ") return line;
    const id = taskOfLine(rest, tasks);
    if (id === undefined) return `${lead}${rest}`;
    ticked.push(id);
    return `${lead}[ ] ${rest} ${tickButton(id)}`;
  });
  return { markdown: lines.join("\n"), ticked };
}

/** The same reply with one task's lines ticked (done) or unticked again. */
export function flipTick(markdown: string, taskId: number, done: boolean): string {
  return markdown
    .split("\n")
    .map((line) => {
      const button = BUTTON.exec(line);
      if (!button || Number(button[1]) !== taskId) return line;
      const item = TASK_ITEM.exec(line.slice(0, button.index));
      if (!item) return line;
      const [, lead, , rest] = item;
      const bare = rest.replace(/^~~([^]*)~~$/, "$1");
      return done ? `${lead}[x] ~~${bare}~~ ${tickButton(taskId, "↩ Undo")}` : `${lead}[ ] ${bare} ${tickButton(taskId)}`;
    })
    .join("\n");
}

/** The reply without its buttons, for a client that would not take them. */
export const withoutTicks = (markdown: string) => markdown.replace(/\s*<tg-button\b[^>]*>[^<]*<\/tg-button>/g, "");

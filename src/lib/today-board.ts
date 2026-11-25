import "server-only";
import { createHash } from "node:crypto";
import { InlineKeyboard, type Bot } from "grammy";
import { retire, sendHtml } from "./chat-log";
import type { RichMessage } from "./rich";
import { requireDb } from "./db";
import { esc, i } from "./html";
import { splitToday } from "./today";
import { progress, subtasksFor } from "./subtasks";
import { finishTask } from "./recurrence";
import { scheduleReminder } from "./reminders";
import { getSettings, updateSettings } from "./settings";
import { clockOf, inDayOrder, OPEN_STATUSES, type Task } from "./tasks";
import { habitStats, isHabit } from "./habits";
import { dayBounds, formatTime, localDate, parseLocalDateTime, TIMEZONE } from "./time";

/**
 * The pinned "Today" message, sent as a Telegram rich message. Every task
 * shows once, with its own "✓ Done" at the end of its line (a tap on the
 * native checkbox is not reported to the bot, so the line carries the
 * button). Parts sit under their task, each with its own "✓ Done".
 * Finished tasks fold away under "✅ Done". If Telegram refuses the rich
 * form, the HTML board below is sent instead: the same list as text, and
 * one full-width button per task, in the same order. There is exactly one
 * board, its message id is kept in settings, and it is edited in place
 * whenever anything about today changes.
 *
 *   📋 Sat 21 Nov
 *   ▰▰▰▱▱▱▱▱▱▱  4/14 done
 *
 *   ⚠️ From earlier days
 *   ☐ Fri 18:00  Develop the website            ✓ Done
 *   To do
 *   ☐ 12:00  Posting stories on Instagram 1/3   ✓ Done
 *       ☑ the new app he's building
 *       ☐ the grammar series                    ✓ Done
 *   ☐ 18:00  Shoot app tutorial on Zoom         ✓ Done
 *   ▸ ✅ Done · 4                                 (folded)
 *
 *   [➕ Add]  [📱 App]
 */
const MAX_BUTTONS = 40;
const BUTTON_ROOM = 17; // the label after "☐ ", about 18 characters in all

const shortDay = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(at).replace(",", "");
const weekday = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" }).format(at);

const FILLER_START = /^(attend|attending|go to|going to|join|visit|do|the|a|an)\s+/i;
const FILLER_WORDS = new Set(["the", "a", "an", "this", "that", "my", "some", "your", "our"]);
const CUT_BEFORE = new Set(["about", "for", "on", "with", "at", "in", "from", "and", "by", "before", "after", "via"]);

/**
 * A task's title cut down to fit a button: "Attend English Speaking Club –
 * More Than a Game" becomes "Speaking Club", "Call the bank about the card"
 * becomes "Call bank". The full title is in the message text above.
 */
export function shortLabel(title: string, room = BUTTON_ROOM): string {
  // Only the part before a dash, colon, bracket or bar.
  let words = title.split(/\s[–—-]\s|[:|(\[]|,\s/)[0].trim().replace(FILLER_START, "").split(/\s+/).filter(Boolean);
  const fits = () => words.join(" ").length <= room;
  if (!fits()) {
    // "Call the bank about the card": keep what comes before "about", "for", "and"...
    const cut = words.findIndex((word, n) => n >= 1 && CUT_BEFORE.has(word.toLowerCase()));
    // A single word before it says little ("Preparation for IELTS exam"); then the words after it are the name.
    const after = words.slice(cut + 1);
    if (cut === 1 && after.length > 0 && after.join(" ").length <= room) words = after;
    else if (cut >= 1) words = words.slice(0, cut);
  }
  if (!fits()) words = words.filter((word, n) => n === 0 || !FILLER_WORDS.has(word.toLowerCase()));
  if (!fits()) {
    // A name ("English Speaking Club") is best known by its last words; a to-do by its first.
    const named = words.filter((word) => /^[A-Z0-9]/.test(word)).length >= 2;
    const kept: string[] = [];
    for (const word of named ? [...words].reverse() : words) {
      if ([...kept, word].join(" ").length > room) break;
      if (named) kept.unshift(word);
      else kept.push(word);
    }
    words = kept.length ? kept : [words[named ? words.length - 1 : 0]];
  }
  const label = words.join(" ");
  return label.length > room ? `${label.slice(0, room - 1)}…` : label;
}

type RichBlock = NonNullable<RichMessage["blocks"]>[number];
type RichButton = Extract<RichBlock, { type: "buttons" }>["buttons"][number];
type RichText = Extract<RichBlock, { type: "paragraph" }>["text"];

/** A title cut to fit a full-width button. */
const clip = (text: string, room: number) => (text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text);

/**
 * The board two ways: as a rich message (a heading, a native checkbox
 * list and buttons inside it) and, if Telegram will not take that, as the
 * HTML message it was before.
 */
type Board = { html: string; keyboard: InlineKeyboard; hash: string; rich: RichMessage; richHash: string; status: string };

/** Which form the board in the chat was sent in is kept with its hash. */
const RICH = "rich:";

/** Thrown when the database has not yet been given the board's columns. */
export class BoardNotReady extends Error {
  constructor() {
    super("The Today message needs migration 0010_board_and_media.sql");
  }
}

/** The board for the local day that contains `day`. */
export async function boardView(day: Date): Promise<Board> {
  const db = requireDb();
  const { start, end } = dayBounds(day);
  const [openRows, finishedRows, settings] = await Promise.all([
    db.from("tasks").select().in("status", OPEN_STATUSES).lt("due_at", end.toISOString()).order("due_at"),
    // Finished today. A repeating task that was ticked off has already rolled
    // to its next date, so it is recognised by when it was completed.
    db.from("tasks").select().gte("completed_at", start.toISOString()).lt("completed_at", end.toISOString()).order("completed_at"),
    getSettings(),
  ]);
  if (openRows.error || finishedRows.error) throw new Error(`boardView: ${(openRows.error ?? finishedRows.error)!.message}`);

  // The same split the app's Today view uses, so the counts always agree.
  const { carried, timed: byTime, done, total } = splitToday([...(openRows.data as Task[]), ...(finishedRows.data as Task[])], day);
  // Timed ones by time, then the ones with no time, his main priorities first.
  const timed = inDayOrder(byTime);

  const bell = (task: Task) => (task.persistent ? " 🔔" : "");
  // A habit's run on its line ("Reading 🔥4"), from the log; nothing for a plan's sessions.
  const habits = [...carried, ...timed, ...done].some(isHabit) ? await habitStats(day).catch(() => []) : [];
  const runs = new Map(habits.filter((stats) => stats.streak >= 2).map((stats) => [stats.task.id, stats.streak]));
  const fire = (task: Task) => (runs.has(task.id) ? ` 🔥${runs.get(task.id)}` : "");
  // Each task's parts: "Post stories 0/3", with the parts listed under it.
  const parts = await subtasksFor([...carried, ...timed, ...done].map((task) => task.id));
  const count = (task: Task) => (parts.get(task.id)?.length ? ` ${progress(parts.get(task.id)!)}` : "");
  const partLines = (task: Task) => (parts.get(task.id) ?? []).map((s) => `      ${s.done ? "☑" : "☐"} ${s.done ? `<s>${esc(s.title)}</s>` : esc(s.title)}`);
  // A done task keeps its own time; a repeating one has already rolled to its next date, so it shows when it was done.
  const doneMoment = (task: Task) => {
    const due = task.due_at ? new Date(task.due_at) : undefined;
    return due && due.getTime() >= start.getTime() && due.getTime() < end.getTime() ? due : new Date(task.completed_at ?? task.due_at!);
  };
  const doneAt = (task: Task) => formatTime(doneMoment(task));
  done.sort((x, y) => doneMoment(x).getTime() - doneMoment(y).getTime());
  const lines = [
    ...carried.flatMap((task) => {
      const at = new Date(task.due_at!);
      return [`☐ ⚠️ ${weekday(at)} ${clockOf(task)} ${esc(task.title)}${count(task)}${bell(task)}${fire(task)}`, ...partLines(task)];
    }),
    ...timed.flatMap((task) => [`☐ ${clockOf(task)} ${esc(task.title)}${count(task)}${bell(task)}${fire(task)}`, ...partLines(task)]),
    ...done.map((task) => `☑ <s>${doneAt(task)} ${esc(task.title)}</s>${count(task)}`),
  ];
  // The first line is what the pinned banner shows, so it is the short one.
  // The pinned banner is a separate one-line message (see postBoard), so the board leads with the date.
  const status = `Today · ${done.length}/${total} done`;
  const html = [`<b>📋 ${esc(shortDay(day))}</b>`, i(`${done.length}/${total} done`), "", total === 0 ? "Nothing is due today, sir." : lines.join("\n")].join("\n");

  // One full-width button per open task, in the same order as the list; its open parts follow it, indented.
  const keyboard = new InlineKeyboard();
  const stamp = (task: Task, carriedOver: boolean) => {
    const at = new Date(task.due_at!);
    return carriedOver ? `⚠️ ${weekday(at)} ${formatTime(at)}` : formatTime(at);
  };
  const plainButtons = [
    ...carried.map((task) => ({ task, carriedOver: true })),
    ...timed.map((task) => ({ task, carriedOver: false })),
  ].flatMap(({ task, carriedOver }) => [
    { text: `☐ ${stamp(task, carriedOver)}  ${clip(task.title, 30)}`, data: `td:${task.id}` },
    ...(parts.get(task.id) ?? []).filter((part) => !part.done).map((part) => ({ text: `   ↳ ☐ ${clip(part.title, 30)}`, data: `st:${part.id}` })),
  ]).slice(0, MAX_BUTTONS);
  for (const button of plainButtons) keyboard.text(button.text, button.data).row();
  // Telegram has no long-press menu on a message, so adding lives in a last row of its own.
  keyboard.text("➕ Add", "td:add");
  // The guided weekly planning, one tap away (26 Nov).
  keyboard.text("🗓 Plan week", "wk:open");
  if (settings.app_url?.startsWith("https://")) keyboard.webApp("📱 App", settings.app_url);

  const hash = createHash("sha256").update(`${status}\n${html}\n${JSON.stringify(keyboard.inline_keyboard)}`).digest("hex");

  // The rich form: each open line ends in its own "✓ Done" (a link-style button inside the text).
  type Item = { blocks: RichBlock[]; has_checkbox: true; is_checked?: true };
  const tick = (data: string, label = "✓ Done"): RichText => ({ type: "button", button: { text: label, callback_data: data, style: "link" } }) as RichText;
  const partsOf = (task: Task): RichBlock[] => {
    const nested = parts.get(task.id) ?? [];
    if (!nested.length) return [];
    return [
      {
        type: "list",
        items: nested.map((part) => ({
          blocks: [{ type: "paragraph", text: part.done ? ({ type: "strikethrough", text: part.title } as RichText) : ([`${part.title}   `, tick(`st:${part.id}`)] as RichText) }],
          has_checkbox: true as const,
          ...(part.done ? { is_checked: true as const } : {}),
        })),
      } as RichBlock,
    ];
  };
  const openItem = (task: Task, when: string): Item => ({
    blocks: [{ type: "paragraph", text: [{ type: "bold", text: when }, `  ${task.title}${count(task)}${bell(task)}${fire(task)}   `, tick(`td:${task.id}`)] as RichText }, ...partsOf(task)],
    has_checkbox: true,
  });
  const doneItem = (task: Task): Item => ({
    blocks: [{ type: "paragraph", text: [{ type: "strikethrough", text: `${doneAt(task)}  ${task.title}` }, `${count(task)}   `, tick(`td:${task.id}`, "↩ Undo")] as RichText }],
    has_checkbox: true,
    is_checked: true,
  });
  const bar = (n: number, of: number) => {
    const filled = of === 0 ? 0 : Math.round((n / of) * 10);
    return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
  };
  const sections: RichBlock[] = [];
  if (total === 0) sections.push({ type: "paragraph", text: "Nothing is due today, sir." });
  if (carried.length) {
    sections.push({ type: "heading", size: 4, text: "⚠️ From earlier days" });
    sections.push({ type: "list", items: carried.map((task) => openItem(task, `${weekday(new Date(task.due_at!))} ${clockOf(task)}`)) } as RichBlock);
  }
  if (timed.length) {
    sections.push({ type: "heading", size: 4, text: "To do" });
    sections.push({ type: "list", items: timed.map((task) => openItem(task, clockOf(task))) } as RichBlock);
  }
  if (total > 0 && carried.length + timed.length === 0) sections.push({ type: "paragraph", text: "🎉 Everything for today is done, sir." });
  if (done.length) {
    // Finished ones fold away, so the open list stays short; the summary keeps the count in view.
    sections.push({ type: "details", summary: `✅ Done · ${done.length}`, blocks: [{ type: "list", items: done.map(doneItem) } as RichBlock] } as RichBlock);
  }
  const lastRow: RichButton[] = [{ text: "➕ Add", callback_data: "td:add" }, { text: "🗓 Plan week", callback_data: "wk:open" }];
  if (settings.app_url?.startsWith("https://")) lastRow.push({ text: "📱 App", web_app: { url: settings.app_url } });
  const rich: RichMessage = {
    blocks: [
      { type: "heading", size: 2, text: `📋 ${shortDay(day)}` },
      { type: "paragraph", text: [bar(done.length, total), "  ", { type: "italic", text: `${done.length}/${total} done` }] as RichText },
      ...sections,
      { type: "buttons", buttons: lastRow },
    ],
    skip_entity_detection: true,
  };
  const richHash = RICH + createHash("sha256").update(`${status}\n${JSON.stringify(rich)}`).digest("hex");
  return { html, keyboard, hash, rich, richHash, status };
}

const gone = (error: unknown) => /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(String((error as { description?: string })?.description ?? error));
const unchanged = (error: unknown) => /message is not modified/i.test(String((error as { description?: string })?.description ?? error));

/**
 * Brings the pinned message up to date. Called after every message, tap,
 * tick and app change; it only talks to Telegram when the board has changed.
 * Never throws: a board that cannot be updated must not break what was asked.
 */
export async function refreshBoard(bot: Bot, chatId: number): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.today_message_id || !settings.today_message_day) return;
    // The board keeps showing the day it was made for until the next one replaces it.
    const day = parseLocalDateTime(`${String(settings.today_message_day).slice(0, 10)}T12:00`);
    if (!day) return;
    const board = await boardView(day);
    // No one-line banner yet (a board from before banners, or one that failed to send):
    // post it now and pin it, so the pinned bar reads "Today · 3/14 done" and nothing more.
    if ("today_status_id" in settings && !settings.today_status_id) {
      const statusId = (await bot.api.sendMessage(chatId, board.status, { disable_notification: true })).message_id;
      await updateSettings({ today_status_id: statusId });
      await bot.api.pinChatMessage(chatId, statusId, { disable_notification: true }).catch((error) => console.error("Could not pin the banner:", error));
      await bot.api.unpinChatMessage(chatId, Number(settings.today_message_id)).catch(() => undefined);
      settings.today_status_id = statusId;
    }
    const isRich = settings.today_message_hash?.startsWith(RICH) ?? false;
    const hash = isRich ? board.richHash : board.hash;
    if (hash === settings.today_message_hash) return;
    try {
      // A rich message is edited with new rich content, so its checkboxes update in place.
      if (isRich) await bot.api.editMessageText(chatId, Number(settings.today_message_id), board.rich);
      else await bot.api.editMessageText(chatId, Number(settings.today_message_id), board.html, { parse_mode: "HTML", reply_markup: board.keyboard });
    } catch (error) {
      if (gone(error)) {
        // He deleted it: stop trying until /today or the next brief makes a new one.
        await updateSettings({ today_message_id: null, today_message_hash: null });
        return;
      }
      if (!unchanged(error)) {
        // Telegram would not take the new rich board as an edit: a fresh board replaces it
        // (rich if it is accepted when sent, the plain one otherwise), so the board never goes stale.
        if (isRich) {
          console.error("The rich Today board could not be edited; posting a fresh one:", error);
          await postBoard(bot, chatId, day);
          return;
        }
        throw error;
      }
    }
    // The pinned one-line banner follows the board's counts.
    if (settings.today_status_id) {
      await bot.api.editMessageText(chatId, Number(settings.today_status_id), board.status).catch((error) => {
        if (!unchanged(error)) console.error("Could not update the pinned banner:", error);
      });
    }
    await updateSettings({ today_message_hash: hash });
  } catch (error) {
    console.error("Could not refresh the Today message:", error);
  }
}

/**
 * Sends a fresh board for today, pins it silently, and removes the previous
 * one (unpinned and deleted). Used with the morning brief and by /today.
 */
export async function postBoard(bot: Bot, chatId: number, now = new Date()): Promise<number> {
  const settings = await getSettings();
  // Without its columns (migration 0010 not yet applied) the board could be
  // sent but never found again, so it is not sent at all.
  if (!("today_message_id" in settings)) throw new BoardNotReady();
  const previous = settings.today_message_id;
  const previousStatus = settings.today_status_id;
  const board = await boardView(now);
  // The banner: a one-line message pinned right above the board. Telegram's pinned bar shows
  // the start of the pinned message with its lines run together, so this keeps it to
  // "Today · 3/14 done" and nothing else.
  const statusId = (await bot.api.sendMessage(chatId, board.status, { disable_notification: true })).message_id;
  let messageId: number;
  let hash: string;
  try {
    messageId = (await bot.api.sendRichMessage(chatId, board.rich, { disable_notification: true })).message_id;
    hash = board.richHash;
  } catch (error) {
    // Telegram would not take the rich form: the HTML board does the same job.
    console.error("The rich Today message was refused; sending the plain board:", error);
    messageId = await sendHtml(bot, chatId, board.html, { keyboard: board.keyboard, silent: true });
    hash = board.hash;
  }
  await updateSettings({ today_message_id: messageId, today_message_day: localDate(now), today_message_hash: hash });
  // Kept separately, so the board still works if this column is not there yet (migration 0015).
  await updateSettings({ today_status_id: statusId }).catch((error) => console.error("Could not keep the banner's id:", error));
  await bot.api.pinChatMessage(chatId, statusId, { disable_notification: true }).catch((error) => console.error("Could not pin the banner:", error));
  // Any older day list sent by /today before the board existed goes too.
  await retire({ kinds: ["cmd:today"] }, now);
  // Yesterday's banner and board are unpinned and removed (a bot may delete its own messages for 48 hours).
  for (const old of [previousStatus, previous]) {
    if (!old || Number(old) === messageId || Number(old) === statusId) continue;
    await bot.api.unpinChatMessage(chatId, Number(old)).catch(() => undefined);
    await bot.api.deleteMessage(chatId, Number(old)).catch(() => undefined);
  }
  return messageId;
}

/** A tap on a task's button: done, or back to open. Plain code, no AI. Returns the pop-up text. */
export async function toggleFromBoard(taskId: number, now = new Date()): Promise<string> {
  const db = requireDb();
  const found = await db.from("tasks").select().eq("id", taskId).maybeSingle();
  if (found.error) throw new Error(`toggleFromBoard: ${found.error.message}`);
  const task = found.data as Task | null;
  if (!task) return "That task is gone, sir.";
  if (task.status === "done") {
    const { error } = await db.from("tasks").update({ status: task.due_at ? "todo" : "inbox", completed_at: null }).eq("id", task.id);
    if (error) throw new Error(`toggleFromBoard: ${error.message}`);
    if (task.due_at && new Date(task.due_at).getTime() > now.getTime()) await scheduleReminder(task.id, new Date(task.due_at));
    return "Back on the list, sir.";
  }
  if (!OPEN_STATUSES.includes(task.status)) return "That one is already settled, sir.";
  // A repeating task ticked off today has moved to its next date; ticking it again changes nothing.
  if (task.completed_at && localDate(new Date(task.completed_at)) === localDate(now) && task.due_at && new Date(task.due_at).getTime() >= dayBounds(now).end.getTime()) {
    return "Already done today, sir. It comes round again on its next date.";
  }
  const { nextLabel } = await finishTask(task, "done", now);
  return nextLabel ? `Done. Next one ${nextLabel}.` : "Done, sir.";
}

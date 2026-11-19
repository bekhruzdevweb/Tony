import "server-only";
import { createHash } from "node:crypto";
import { InlineKeyboard, type Bot } from "grammy";
import { retire, sendHtml } from "./chat-log";
import { requireDb } from "./db";
import { esc } from "./html";
import { finishTask } from "./recurrence";
import { scheduleReminder } from "./reminders";
import { getSettings, updateSettings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { dayBounds, formatTime, localDate, parseLocalDateTime, TIMEZONE } from "./time";

/**
 * The pinned "Today" message: the whole day as a list in the text, and a
 * short button per task that ticks it off. There is exactly one, its
 * message id is kept in settings, and it is edited in place whenever
 * anything about today changes.
 *
 *   📋 Today · Fri 20 Nov   1/3
 *
 *   ☐ ⚠️ Wed 23:29 Reply to the school
 *   ☐ 18:00 English Speaking Club
 *   ☑ 09:00 Morning walk          (struck through, at the bottom)
 *
 *   [☐ Reply to school] [☐ Speaking Club]
 *   [☑ Morning walk]
 *   [➕ Add]            [📱 App]
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

type Board = { html: string; keyboard: InlineKeyboard; hash: string };

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

  const open = openRows.data as Task[];
  // Carried over from earlier days first, then today's in time order, then what is done.
  const carried = open.filter((task) => new Date(task.due_at!).getTime() < start.getTime());
  const timed = open.filter((task) => new Date(task.due_at!).getTime() >= start.getTime());
  const done = (finishedRows.data as Task[]).filter((task) => task.status === "done" || (task.due_at !== null && new Date(task.due_at).getTime() >= end.getTime()));
  const total = carried.length + timed.length + done.length;

  const bell = (task: Task) => (task.persistent ? " 🔔" : "");
  const lines = [
    ...carried.map((task) => {
      const at = new Date(task.due_at!);
      return `☐ ⚠️ ${weekday(at)} ${formatTime(at)} ${esc(task.title)}${bell(task)}`;
    }),
    ...timed.map((task) => `☐ ${formatTime(new Date(task.due_at!))} ${esc(task.title)}${bell(task)}`),
    // A repeating task done today shows the time it was done, not its next date.
    ...done.map((task) => `☑ <s>${formatTime(new Date(task.completed_at ?? task.due_at!))} ${esc(task.title)}</s>`),
  ];
  const html = [`<b>📋 Today · ${esc(shortDay(day))}</b>   ${done.length}/${total}`, "", total === 0 ? "Nothing is due today, sir." : lines.join("\n")].join("\n");

  // Two short buttons a row, in the same order as the list.
  const buttons = [
    ...[...carried, ...timed].map((task) => ({ task, mark: "☐" })),
    ...done.map((task) => ({ task, mark: "☑" })),
  ].slice(0, MAX_BUTTONS);
  const labels = buttons.map(({ task }) => shortLabel(task.title));
  // Two tasks that shorten to the same words are told apart by their time.
  const label = (n: number) => {
    const same = labels.filter((other) => other === labels[n]).length > 1;
    const at = buttons[n].task.due_at ? formatTime(new Date(buttons[n].task.due_at!)) : "";
    return `${buttons[n].mark} ${same && at ? `${shortLabel(buttons[n].task.title, BUTTON_ROOM - 6)} ${at}` : labels[n]}`;
  };
  const keyboard = new InlineKeyboard();
  buttons.forEach(({ task }, n) => {
    keyboard.text(label(n), `td:${task.id}`);
    if (n % 2 === 1) keyboard.row();
  });
  if (buttons.length % 2 === 1) keyboard.row();
  // Telegram has no long-press menu on a message, so adding lives in a last row of its own.
  keyboard.text("➕ Add", "td:add");
  if (settings.app_url?.startsWith("https://")) keyboard.webApp("📱 App", settings.app_url);

  const hash = createHash("sha256").update(`${html}\n${JSON.stringify(keyboard.inline_keyboard)}`).digest("hex");
  return { html, keyboard, hash };
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
    if (board.hash === settings.today_message_hash) return;
    try {
      await bot.api.editMessageText(chatId, Number(settings.today_message_id), board.html, { parse_mode: "HTML", reply_markup: board.keyboard });
    } catch (error) {
      if (gone(error)) {
        // He deleted it: stop trying until /today or the next brief makes a new one.
        await updateSettings({ today_message_id: null, today_message_hash: null });
        return;
      }
      if (!unchanged(error)) throw error;
    }
    await updateSettings({ today_message_hash: board.hash });
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
  const board = await boardView(now);
  const messageId = await sendHtml(bot, chatId, board.html, { keyboard: board.keyboard, silent: true });
  await updateSettings({ today_message_id: messageId, today_message_day: localDate(now), today_message_hash: board.hash });
  await bot.api.pinChatMessage(chatId, messageId, { disable_notification: true }).catch((error) => console.error("Could not pin the Today message:", error));
  // Any older day list sent by /today before the board existed goes too.
  await retire({ kinds: ["cmd:today"] }, now);
  if (previous && Number(previous) !== messageId) {
    await bot.api.unpinChatMessage(chatId, Number(previous)).catch(() => undefined);
    // A bot can delete its own message for 48 hours, which covers yesterday's.
    await bot.api.deleteMessage(chatId, Number(previous)).catch(() => undefined);
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

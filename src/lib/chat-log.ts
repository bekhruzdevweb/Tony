import "server-only";
import type { Bot, InlineKeyboard } from "grammy";
import { requireDb } from "./db";
import { plain } from "./html";

/**
 * Sending, tracking and tidying Tony's Telegram messages.
 *
 * A message that will be removed later is recorded with its kind. When it
 * has served its purpose it gets a delete_after time, and the minute tick
 * removes it. Anything not recorded here is never deleted.
 */
export type MessageKind =
  | "reminder"
  | "prompt"
  | "stale"
  | "brief:morning"
  | "brief:evening"
  | "confirmation"
  | "cmd:today"
  | "cmd:inbox"
  | "cmd:app"
  | "cmd:help"
  | "cmd:ping"
  | "cmd:voice"
  | "cmd:routine"
  | "cmd:undo"
  | "cmd:memory"
  | "cmd:habits"
  | "plan"
  | "voice"
  // An apology, "I don't know that command", and the message that caused it.
  | "error";

/** Telegram lets a bot delete a message for 48 hours; stay safely inside that. */
const DELETABLE_HOURS = 47;
export const CONFIRMATION_HOURS = 3;
/** Replies to his voice notes are kept for a day. */
export const VOICE_REPLY_HOURS = 24;
const SEND_TIMEOUT_MS = 8_000;

/** Errors and "unknown command" replies, and what caused them, go after ten minutes. */
export const ERROR_MINUTES = 10;

export const hoursFromNow = (hours: number, now = new Date()) => new Date(now.getTime() + hours * 60 * 60_000);

type TelegramSignal = Parameters<Bot["api"]["sendMessage"]>[3];
const timeout = () => AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as TelegramSignal;

const isParseError = (error: unknown) => /can't parse entities|unsupported start tag|can't find end tag/i.test(String((error as { description?: string })?.description ?? error));

/**
 * Sends formatted (HTML) text. If Telegram rejects the markup, the same
 * words go out unformatted: a plain message beats a lost one.
 */
export async function sendHtml(
  bot: Bot,
  chatId: number,
  html: string,
  options: { keyboard?: InlineKeyboard; silent?: boolean } = {},
): Promise<number> {
  const extra = { reply_markup: options.keyboard, disable_notification: options.silent, link_preview_options: { is_disabled: true } };
  try {
    return (await bot.api.sendMessage(chatId, html, { ...extra, parse_mode: "HTML" }, timeout())).message_id;
  } catch (error) {
    if (!isParseError(error)) throw error;
    console.error("Telegram rejected the formatting; sending plain text:", error);
    return (await bot.api.sendMessage(chatId, plain(html), extra, timeout())).message_id;
  }
}

/** Rewrites a message in place, with the same plain-text fallback. Returns false if it could not be edited. */
export async function editHtml(bot: Bot, chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard, isCaption = false): Promise<boolean> {
  try {
    // A photo or file carries its words as a caption, which is edited differently.
    if (isCaption) await bot.api.editMessageCaption(chatId, messageId, { caption: html.slice(0, 1024), parse_mode: "HTML", reply_markup: keyboard });
    else await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
    return true;
  } catch (error) {
    if (isParseError(error)) {
      const retry = isCaption
        ? bot.api.editMessageCaption(chatId, messageId, { caption: plain(html).slice(0, 1024), reply_markup: keyboard })
        : bot.api.editMessageText(chatId, messageId, plain(html), { reply_markup: keyboard });
      return retry.then(
        () => true,
        () => false,
      );
    }
    console.error("Could not edit the message:", error);
    return false;
  }
}

// Tracking is best-effort: a failure here must never stop a message going out.
async function quietly(label: string, work: () => PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  try {
    const { error } = await work();
    if (error) console.error(`${label}: ${error.message}`);
  } catch (error) {
    console.error(`${label}:`, error);
  }
}

/** Records a message so it can be tidied away later. */
export async function track(
  messageId: number,
  kind: MessageKind,
  options: { taskId?: number; taskIds?: number[]; deleteAfter?: Date; incoming?: boolean } = {},
): Promise<void> {
  const ids = [...new Set([...(options.taskIds ?? []), ...(options.taskId !== undefined ? [options.taskId] : [])])].filter(Number.isFinite);
  const row = {
    message_id: messageId,
    kind,
    // One task: its own column, so settling that task removes the message (see settleReminders).
    task_id: options.taskId ?? (ids.length === 1 ? ids[0] : null),
    incoming: options.incoming ?? false,
    delete_after: options.deleteAfter?.toISOString() ?? null,
  };
  const db = requireDb();
  if (ids.length === 0) return quietly("track", () => db.from("chat_messages").upsert(row, { onConflict: "message_id" }));
  try {
    const { error } = await db.from("chat_messages").upsert({ ...row, task_ids: ids }, { onConflict: "message_id" });
    if (!error) return;
    // Before migration 0030 there is no task_ids column: the message is still recorded.
    if (!/task_ids/i.test(error.message)) console.error(`track: ${error.message}`);
  } catch (error) {
    console.error("track:", error);
  }
  return quietly("track", () => db.from("chat_messages").upsert(row, { onConflict: "message_id" }));
}

/** A tapped message whose task is settled goes this soon: he sees the outcome, then the chat is clean. */
export const SETTLED_MINUTES = 1;
/** A confirmation of something done or moved, in his own words, goes after this long: read, then gone. */
export const DONE_CONFIRMATION_MINUTES = 2;
export const minutesFromNow = (minutes: number, now = new Date()) => new Date(now.getTime() + minutes * 60_000);

/** What a tracked message is ("prompt", "brief:morning", ...), if Tony recorded it. */
export async function trackedKind(messageId: number): Promise<MessageKind | undefined> {
  try {
    const { data } = await requireDb().from("chat_messages").select("kind").eq("message_id", messageId).limit(1);
    return ((data ?? []) as { kind: MessageKind }[])[0]?.kind;
  } catch {
    return undefined;
  }
}

/**
 * From the minute tick: a message about one or more tasks (a follow-up, a
 * list of what is still open, a receipt, a question about a time) goes on the
 * next tick once every task in it is settled: no longer open, or moved to a
 * time still ahead after the message was sent. However it was settled, by a
 * button, in his words or in the app (22 Nov: "⏰ Still open from today:
 * Message teacher…" stayed after that task was done). Briefs are kept.
 * Returns how many were marked. Never throws.
 */
export async function retireSettled(now = new Date()): Promise<number> {
  try {
    const db = requireDb();
    const { data, error } = await db
      .from("chat_messages")
      .select("message_id, task_ids, created_at, kind, delete_after")
      .is("deleted_at", null)
      .eq("protected", false)
      .not("task_ids", "is", null)
      .gte("created_at", new Date(now.getTime() - DELETABLE_HOURS * 60 * 60_000).toISOString())
      .order("id", { ascending: false })
      .limit(60);
    if (error) return 0;
    const rows = ((data ?? []) as { message_id: number; task_ids: number[] | null; created_at: string; kind: MessageKind; delete_after: string | null }[]).filter(
      (row) => !row.kind.startsWith("brief") && (row.task_ids ?? []).length > 0 && !(row.delete_after && new Date(row.delete_after).getTime() <= now.getTime()),
    );
    if (rows.length === 0) return 0;
    const ids = [...new Set(rows.flatMap((row) => (row.task_ids ?? []).map(Number)))];
    const tasks = await db.from("tasks").select("id, status, due_at, updated_at").in("id", ids);
    if (tasks.error) return 0;
    const byId = new Map(((tasks.data ?? []) as { id: number; status: string; due_at: string | null; updated_at: string }[]).map((task) => [Number(task.id), task]));
    const open = new Set(["inbox", "todo", "in_progress"]);
    const settled = (id: number, sentAt: number) => {
      const task = byId.get(id);
      if (!task || !open.has(task.status)) return true;
      return Boolean(task.due_at && new Date(task.due_at).getTime() > now.getTime() && new Date(task.updated_at).getTime() > sentAt + 1_000);
    };
    let marked = 0;
    const soon = minutesFromNow(DONE_CONFIRMATION_MINUTES, now);
    for (const row of rows) {
      const sentAt = new Date(row.created_at).getTime();
      if (!(row.task_ids ?? []).map(Number).every((id) => settled(id, sentAt))) continue;
      // Waiting for an answer (a follow-up, a question): it goes now. A receipt keeps its own few
      // minutes ("✓ Done" stays ten), but no longer than ten minutes from here.
      const planned = row.delete_after ? new Date(row.delete_after) : undefined;
      if (planned && planned.getTime() <= soon.getTime() + 60_000) continue;
      await setFate(Number(row.message_id), { deleteAfter: planned ? soon : now });
      marked++;
    }
    return marked;
  } catch (error) {
    console.error("retireSettled:", error);
    return 0;
  }
}

/** Changes what will happen to one tracked message (for example, a tapped reminder becomes a confirmation). */
export function setFate(messageId: number, fate: { kind?: MessageKind; deleteAfter: Date | null }): Promise<void> {
  return quietly("setFate", () =>
    requireDb()
      .from("chat_messages")
      .update({ ...(fate.kind ? { kind: fate.kind } : {}), delete_after: fate.deleteAfter?.toISOString() ?? null })
      .eq("message_id", messageId)
      .is("deleted_at", null),
  );
}

/**
 * Marks messages as finished with, to be removed on the next tick: all of
 * the given kinds, or everything about one task.
 */
export function retire(which: { kinds?: MessageKind[]; taskId?: number; exceptMessageId?: number }, now = new Date()): Promise<void> {
  return quietly("retire", () => {
    let query = requireDb().from("chat_messages").update({ delete_after: now.toISOString() }).is("deleted_at", null);
    if (which.kinds) query = query.in("kind", which.kinds);
    if (which.taskId !== undefined) query = query.eq("task_id", which.taskId);
    if (which.exceptMessageId !== undefined) query = query.neq("message_id", which.exceptMessageId);
    return query;
  });
}

/**
 * Removes one message now (his command, once it has been handled). If
 * Telegram cannot be reached, the message is left to the next tick instead.
 */
export async function deleteNow(bot: Bot, chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(chatId, messageId, timeout());
    await quietly("deleteNow", () => requireDb().from("chat_messages").update({ deleted_at: new Date().toISOString() }).eq("message_id", messageId));
  } catch (error) {
    // Already gone, or too old: nothing more to do.
    if ((error as { error_code?: number })?.error_code === 400) return;
    await track(messageId, "cmd:today", { incoming: true, deleteAfter: new Date() });
  }
}

/** He pinned it or replied to it: never remove it. */
export function protect(messageId: number): Promise<void> {
  return quietly("protect", () => requireDb().from("chat_messages").update({ protected: true }).eq("message_id", messageId));
}

/** Sends a formatted message and records it. */
export async function sendTracked(
  bot: Bot,
  chatId: number,
  html: string,
  options: { keyboard?: InlineKeyboard; silent?: boolean; kind?: MessageKind; taskId?: number; deleteAfter?: Date } = {},
): Promise<number> {
  const messageId = await sendHtml(bot, chatId, html, options);
  if (options.kind) await track(messageId, options.kind, options);
  return messageId;
}

export type CleanupResult = { deleted: number; kept: number; expired: number };

/**
 * Called from the minute tick: removes every message whose time has come.
 * Never touches a protected message, the chat's pinned message, or anything
 * older than Telegram allows a bot to delete.
 */
export async function runCleanup(bot: Bot, chatId: number, now = new Date()): Promise<CleanupResult> {
  const db = requireDb();
  const result: CleanupResult = { deleted: 0, kept: 0, expired: 0 };
  const due = await db
    .from("chat_messages")
    .select("id, message_id, created_at")
    .is("deleted_at", null)
    .eq("protected", false)
    .lte("delete_after", now.toISOString())
    .order("id")
    .limit(100);
  if (due.error) throw new Error(`runCleanup: ${due.error.message}`);
  const rows = (due.data ?? []) as { id: number; message_id: number; created_at: string }[];
  if (rows.length === 0) return result;

  // A message he pinned without Tony being told still shows up here.
  let pinned: number | undefined;
  try {
    pinned = (await bot.api.getChat(chatId, timeout())).pinned_message?.message_id;
  } catch (error) {
    console.error("Could not check the pinned message; skipping this cleanup:", error);
    return result;
  }

  const tooOld = now.getTime() - DELETABLE_HOURS * 60 * 60_000;
  const closed: number[] = []; // rows to stop considering, deleted or not
  const toDelete: typeof rows = [];
  for (const row of rows) {
    if (Number(row.message_id) === pinned) {
      await protect(Number(row.message_id));
      result.kept++;
    } else if (new Date(row.created_at).getTime() < tooOld) {
      closed.push(row.id);
      result.expired++;
    } else {
      toDelete.push(row);
    }
  }

  if (toDelete.length > 0) {
    const ids = toDelete.map((row) => Number(row.message_id));
    try {
      await bot.api.deleteMessages(chatId, ids, timeout());
      result.deleted += ids.length;
      closed.push(...toDelete.map((row) => row.id));
    } catch (error) {
      // One bad id fails the whole batch; go one by one. A message that is
      // already gone counts as done. A network fault leaves it for next time.
      console.error("Batch delete failed, deleting one by one:", error);
      for (const row of toDelete) {
        try {
          await bot.api.deleteMessage(chatId, Number(row.message_id), timeout());
          result.deleted++;
          closed.push(row.id);
        } catch (single) {
          if ((single as { error_code?: number })?.error_code === 400) closed.push(row.id);
        }
      }
    }
  }

  if (closed.length > 0) {
    const marked = await db.from("chat_messages").update({ deleted_at: now.toISOString() }).in("id", closed);
    if (marked.error) console.error(`runCleanup: ${marked.error.message}`);
  }
  return result;
}

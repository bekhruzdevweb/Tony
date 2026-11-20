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
export function track(
  messageId: number,
  kind: MessageKind,
  options: { taskId?: number; deleteAfter?: Date; incoming?: boolean } = {},
): Promise<void> {
  return quietly("track", () =>
    requireDb()
      .from("chat_messages")
      .upsert(
        {
          message_id: messageId,
          kind,
          task_id: options.taskId ?? null,
          incoming: options.incoming ?? false,
          delete_after: options.deleteAfter?.toISOString() ?? null,
        },
        { onConflict: "message_id" },
      ),
  );
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

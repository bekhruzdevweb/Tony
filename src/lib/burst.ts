import "server-only";
import type { Update } from "grammy/types";
import { requireDb } from "./db";
import { env } from "./env";
import { groupBursts } from "./smart-rules";

/**
 * The burst rule (phase b, 21 Nov): what he sends within a minute (a photo,
 * a link, a voice note, some words, in any order) is one request. Each
 * message waits here a few seconds; only the last of a burst answers, for
 * all of them. Before migration 0024 there is no table: every message is
 * answered on its own, as before.
 */

type Row = { id: number; chat_id: number; update_id: number; payload: Update; received_at: string; claimed_at: string | null };

/** A message that can be part of a burst: words, a voice note, a photo, a file, a forward. Commands and taps are answered at once. */
export function burstable(update: Update): boolean {
  const message = update.message;
  if (!message || message.chat.type !== "private") return false;
  // Only his own messages wait; anyone else goes through the bot's usual door, which turns strangers away.
  if (env.telegramOwnerId === undefined || message.from?.id !== env.telegramOwnerId) return false;
  if (message.text?.trim().startsWith("/")) return false;
  return Boolean(message.text || message.voice || message.audio || message.photo || message.video || message.document || message.animation || message.caption);
}

/** Puts a message in the waiting room. False if it cannot wait (no table yet): then it is answered on its own. */
export async function holdForBurst(update: Update, now = new Date()): Promise<boolean> {
  const chatId = update.message?.chat.id;
  if (chatId === undefined) return false;
  const { error } = await requireDb().from("incoming").insert({ chat_id: chatId, update_id: update.update_id, payload: update, received_at: now.toISOString() });
  if (error) {
    console.warn(`holdForBurst: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * After the quiet seconds: if a later message came, it answers for this one
 * too (undefined here). Otherwise this one takes every waiting message of the
 * chat, split into requests of a minute each, oldest first.
 */
export async function takeBurst(update: Update): Promise<Update[][] | undefined> {
  const chatId = update.message?.chat.id;
  if (chatId === undefined) return undefined;
  const db = requireDb();
  const later = await db.from("incoming").select("id").eq("chat_id", chatId).is("claimed_at", null).gt("update_id", update.update_id).limit(1);
  if (later.error) return [[update]];
  if ((later.data ?? []).length > 0) return undefined;
  const claimed = await db.from("incoming").update({ claimed_at: new Date().toISOString() }).eq("chat_id", chatId).is("claimed_at", null).select();
  if (claimed.error) return [[update]];
  const rows = (claimed.data ?? []) as Row[];
  if (rows.length === 0) return undefined;
  return groupBursts(rows).map((group) => group.sort((a, b) => a.update_id - b.update_id).map((row) => row.payload));
}

/** Waiting-room rows older than two days go. */
export async function pruneIncoming(now = new Date()): Promise<void> {
  await requireDb()
    .from("incoming")
    .delete()
    .lt("received_at", new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString())
    .then(({ error }) => error && console.warn(`pruneIncoming: ${error.message}`));
}

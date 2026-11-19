import "server-only";
import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import { getDb, requireDb } from "./db";

/**
 * Two guards against Tony saying the same thing twice.
 *
 * 1. Telegram may deliver one update several times (it did with the
 *    Business connection event). Each update id is recorded, and a second
 *    arrival is dropped before anything acts on it.
 * 2. Whatever the cause, the same text with the same buttons is never sent
 *    twice running within a few minutes: the second send is skipped and the
 *    first message stands.
 */
const REPEAT_WINDOW_MS = 5 * 60_000;

/** True the first time an update is seen; false for a redelivery. */
export async function firstSight(updateId: number): Promise<boolean> {
  const db = getDb();
  if (!db) return true;
  try {
    const { error } = await db.from("updates_seen").insert({ update_id: updateId });
    if (!error) return true;
    // 23505: the row is already there, so this update has been handled.
    if (error.code === "23505") return false;
    console.error(`firstSight: ${error.message}`);
  } catch (error) {
    console.error("firstSight:", error);
  }
  // If the check itself fails, handling the update twice beats not handling it.
  return true;
}

/** Forgets update ids old enough that Telegram will never resend them. */
export async function pruneUpdates(now = new Date()): Promise<void> {
  const { error } = await requireDb().from("updates_seen").delete().lt("seen_at", new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString());
  if (error) console.error(`pruneUpdates: ${error.message}`);
}

type LastSent = { last_sent_hash: string | null; last_sent_at: string | null; last_sent_id: number | null };

/**
 * Makes every sendMessage pass through the "not twice running" check. It is
 * installed on the bot's API client, so it covers every way Tony sends text.
 */
export function refuseRepeats(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method !== "sendMessage") return prev(method, payload, signal);
    const message = payload as { chat_id?: number | string; text?: string; reply_markup?: unknown };
    const db = getDb();
    if (!db || typeof message.text !== "string") return prev(method, payload, signal);

    const hash = createHash("sha256").update(`${message.chat_id}\n${message.text}\n${JSON.stringify(message.reply_markup ?? null)}`).digest("hex");
    try {
      const { data } = await db.from("settings").select("last_sent_hash, last_sent_at, last_sent_id").limit(1).maybeSingle();
      const last = data as LastSent | null;
      const recent = last?.last_sent_at ? Date.now() - new Date(last.last_sent_at).getTime() < REPEAT_WINDOW_MS : false;
      if (last && recent && last.last_sent_hash === hash && last.last_sent_id !== null) {
        console.warn("Skipped a repeated message:", message.text.slice(0, 80));
        // Answer as Telegram would have, pointing at the message already in the chat.
        const stood = { message_id: Number(last.last_sent_id), date: Math.floor(Date.now() / 1000), chat: { id: Number(message.chat_id), type: "private" }, text: message.text };
        return { ok: true, result: stood } as unknown as Awaited<ReturnType<typeof prev>>;
      }
    } catch (error) {
      console.error("refuseRepeats: could not check the last message:", error);
    }

    const response = await prev(method, payload, signal);
    if (response.ok) {
      const sent = response.result as unknown as { message_id: number };
      await db
        .from("settings")
        .update({ last_sent_hash: hash, last_sent_at: new Date().toISOString(), last_sent_id: sent.message_id })
        .eq("id", true)
        .then(({ error }) => error && console.error(`refuseRepeats: ${error.message}`));
    }
    return response;
  });
}

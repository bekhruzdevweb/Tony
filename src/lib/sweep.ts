import "server-only";
import type { Bot } from "grammy";
import { track } from "./chat-log";
import { requireDb } from "./db";
import { firstSight } from "./dedupe";
import { OPEN_STATUSES } from "./tasks";

/**
 * /clean: a sweep of the whole recent chat, in plain code (no AI).
 *
 * Telegram numbers the messages of a private chat one after another, his
 * and Tony's alike, so Tony can walk back from the newest number and delete
 * every message he is allowed to (a bot may delete any message in its
 * private chat for 48 hours). Numbers that are already gone are skipped.
 *
 * Kept: the pinned Today board (and whatever else is pinned), reminders
 * still waiting for a tap, and the latest morning brief.
 */
const SWEEP_SPAN = 500;
const BATCH = 100;
/** Telegram allows 48 hours; stay inside it. */
const DELETABLE_HOURS = 47;
const DONE_MESSAGE_SECONDS = 10;

/**
 * A one-time sweep after a deployment: the first tick to see this number
 * runs it, and records the number as seen so it never runs again. Change
 * the number to sweep once more after a later deployment.
 */
const SWEEP_ONCE_ID = -20261120;

export type SweepResult = { deleted: number; kept: number; from: number; to: number };

/** Message numbers that must survive a sweep. */
async function keepers(bot: Bot, chatId: number): Promise<Set<number>> {
  const db = requireDb();
  const keep = new Set<number>();
  const add = (id: unknown) => {
    if (id !== null && id !== undefined && Number.isFinite(Number(id))) keep.add(Number(id));
  };

  const [settings, waiting, brief, briefVoice] = await Promise.all([
    db.from("settings").select("today_message_id").limit(1).maybeSingle(),
    // Reminders sent and not yet answered, for tasks that are still open.
    db.from("reminders").select("telegram_message_id, task_id").eq("state", "sent").not("telegram_message_id", "is", null),
    // The latest morning brief (briefs are recorded with attempt 0 for the morning).
    db.from("reminders").select("telegram_message_id").eq("kind", "brief").eq("attempt", 0).not("telegram_message_id", "is", null).order("fire_at", { ascending: false }).limit(1),
    // Its spoken version, if there was one.
    db.from("chat_messages").select("message_id").eq("kind", "brief:morning").is("deleted_at", null),
  ]);
  for (const query of [settings, waiting, brief, briefVoice]) if (query.error) throw new Error(`sweep: ${query.error.message}`);

  add((settings.data as { today_message_id: number | null } | null)?.today_message_id);
  const sent = (waiting.data ?? []) as { telegram_message_id: number; task_id: number | null }[];
  const taskIds = [...new Set(sent.map((row) => row.task_id).filter((id): id is number => id !== null))];
  if (taskIds.length > 0) {
    const open = await db.from("tasks").select("id").in("id", taskIds).in("status", OPEN_STATUSES);
    if (open.error) throw new Error(`sweep: ${open.error.message}`);
    const openIds = new Set((open.data as { id: number }[]).map((task) => Number(task.id)));
    for (const row of sent) if (row.task_id !== null && openIds.has(Number(row.task_id))) add(row.telegram_message_id);
  }
  for (const row of (brief.data ?? []) as { telegram_message_id: number }[]) add(row.telegram_message_id);
  for (const row of (briefVoice.data ?? []) as { message_id: number }[]) add(row.message_id);

  // Whatever is pinned in the chat right now, even if Tony did not pin it.
  const pinned = await bot.api.getChat(chatId).then(
    (chat) => chat.pinned_message?.message_id,
    () => undefined,
  );
  add(pinned);
  return keep;
}

/** The newest message number known to be older than Telegram lets a bot delete: the sweep stops above it. */
async function oldestDeletable(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DELETABLE_HOURS * 60 * 60_000).toISOString();
  const db = requireDb();
  const [tracked, reminders] = await Promise.all([
    db.from("chat_messages").select("message_id").lt("created_at", cutoff).order("message_id", { ascending: false }).limit(1),
    db.from("reminders").select("telegram_message_id").lt("sent_at", cutoff).not("telegram_message_id", "is", null).order("telegram_message_id", { ascending: false }).limit(1),
  ]);
  const old = Math.max(
    Number((tracked.data?.[0] as { message_id?: number } | undefined)?.message_id ?? 0),
    Number((reminders.data?.[0] as { telegram_message_id?: number } | undefined)?.telegram_message_id ?? 0),
  );
  return old + 1;
}

/** Deletes every message from `newest` back about 500 numbers (or to 47 hours ago), except the keepers. */
export async function sweepChat(bot: Bot, chatId: number, newest: number, now = new Date()): Promise<SweepResult> {
  const keep = await keepers(bot, chatId);
  const from = Math.max(1, newest - SWEEP_SPAN + 1, await oldestDeletable(now));
  const ids: number[] = [];
  for (let id = newest; id >= from; id--) if (!keep.has(id)) ids.push(id);

  let deleted = 0;
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    try {
      // Numbers that no longer exist are skipped by Telegram, not refused.
      await bot.api.deleteMessages(chatId, batch);
      deleted += batch.length;
    } catch (error) {
      // If Telegram refuses the batch as a whole, try each number on its own; "not found" is fine.
      console.error("Sweep batch refused, going one by one:", error);
      for (const id of batch) {
        await bot.api.deleteMessage(chatId, id).then(
          () => deleted++,
          () => undefined,
        );
      }
    }
  }

  // Tony's own records follow the chat: what was swept is gone.
  const swept = ids.filter((id) => id <= newest);
  for (let start = 0; start < swept.length; start += BATCH) {
    const { error } = await requireDb()
      .from("chat_messages")
      .update({ deleted_at: now.toISOString() })
      .in("message_id", swept.slice(start, start + BATCH))
      .is("deleted_at", null);
    if (error) console.error(`sweep: ${error.message}`);
  }
  console.log(`Swept the chat: ${ids.length} numbers from ${newest} down to ${from}, ${keep.size} kept.`);
  return { deleted, kept: keep.size, from, to: newest };
}

/**
 * Says "Chat cleaned, sir." and removes it ten seconds later. The tick is a
 * backstop: if this function is cut short, the next tick removes it.
 */
export async function sayCleaned(bot: Bot, chatId: number, messageId?: number): Promise<void> {
  const id = messageId ?? (await bot.api.sendMessage(chatId, "Chat cleaned, sir.", { disable_notification: true })).message_id;
  await track(id, "error", { deleteAfter: new Date(Date.now() + DONE_MESSAGE_SECONDS * 1000) });
  await new Promise((resolve) => setTimeout(resolve, DONE_MESSAGE_SECONDS * 1000));
  await bot.api.deleteMessage(chatId, id).then(
    () => requireDb().from("chat_messages").update({ deleted_at: new Date().toISOString() }).eq("message_id", id),
    () => undefined,
  );
}

/** /clean: sweep everything up to his command, then the ten-second note. */
export async function cleanFromCommand(bot: Bot, chatId: number, commandId: number): Promise<void> {
  await sweepChat(bot, chatId, commandId);
  await sayCleaned(bot, chatId);
}

/**
 * The one sweep after a deployment, from the tick. The note is sent first
 * so its number marks the newest message; the sweep then runs below it.
 */
export async function sweepOnceAfterDeploy(bot: Bot, chatId: number): Promise<boolean> {
  if (!(await firstSight(SWEEP_ONCE_ID))) return false;
  const note = await bot.api.sendMessage(chatId, "Chat cleaned, sir.", { disable_notification: true });
  await sweepChat(bot, chatId, note.message_id - 1);
  await sayCleaned(bot, chatId, note.message_id);
  return true;
}


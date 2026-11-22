import "server-only";
import { requireDb } from "./db";

/**
 * 👎 (phase e, 21 Nov): a reaction on one of Tony's messages saves it, what
 * he had said before it and the conversation around it, in `mistakes`.
 * `npm run mistakes` turns each one into a regression case (evals/mistakes).
 */

/** Which Telegram message a reply became, so a 👎 on it finds its words. Never fails the reply. */
export async function markSent(text: string, telegramMessageId: number | undefined): Promise<void> {
  if (telegramMessageId === undefined) return;
  try {
    const db = requireDb();
    const { data } = await db.from("messages").select("id").eq("role", "tony").eq("text", text).order("id", { ascending: false }).limit(1);
    const row = ((data ?? []) as { id: number }[])[0];
    if (row) await db.from("messages").update({ telegram_message_id: telegramMessageId }).eq("id", row.id);
  } catch {
    // Without migration 0024 there is no column: a 👎 then keeps the latest replies as context.
  }
}

type Logged = { id: number; role: "user" | "tony"; text: string; created_at: string; telegram_message_id?: number | null };

/**
 * What one of Tony's Telegram messages said, if Tony knows: a reply he sent
 * (see markSent), or a voice note (its words are noted when it is sent).
 * Used when he replies to that message, so his words are read as about it.
 */
export async function loggedText(telegramMessageId: number): Promise<string | undefined> {
  try {
    const db = requireDb();
    const found = await db.from("messages").select("text").eq("telegram_message_id", telegramMessageId).limit(1);
    const text = ((found.data ?? []) as { text: string }[])[0]?.text;
    if (text) return text;
    const voices = await db.from("events").select("detail").eq("kind", "voice_note").order("id", { ascending: false }).limit(60);
    const voice = ((voices.data ?? []) as { detail: { message_id?: number; text?: string } | null }[]).find((row) => Number(row.detail?.message_id) === telegramMessageId);
    return voice?.detail?.text || undefined;
  } catch {
    return undefined;
  }
}

/** Saves a mistake: the message he marked (if Tony knows it), his words before it, and the eight messages around it. */
export async function saveMistake(telegramMessageId: number | undefined, note?: string): Promise<boolean> {
  const db = requireDb();
  let marked: Logged | undefined;
  if (telegramMessageId !== undefined) {
    const found = await db.from("messages").select().eq("telegram_message_id", telegramMessageId).limit(1);
    if (!found.error) marked = ((found.data ?? []) as Logged[])[0];
  }
  const recent = await db.from("messages").select().lte("id", marked?.id ?? Number.MAX_SAFE_INTEGER).order("id", { ascending: false }).limit(8);
  const context = ((recent.data ?? []) as Logged[]).reverse().map((row) => ({ role: row.role, text: row.text, at: row.created_at }));
  const tony = marked ?? [...context].reverse().find((row) => row.role === "tony");
  const his = [...context].reverse().find((row) => row.role === "user" && (!tony || ("at" in tony ? row.at <= tony.at : true)));
  const { error } = await db.from("mistakes").insert({
    telegram_message_id: telegramMessageId ?? null,
    tony_text: tony ? ("text" in tony ? tony.text : null) : null,
    his_text: his?.text ?? null,
    // An object, not a bare list: every JSON layer stores it the same way.
    context: { messages: context },
    note: note ?? null,
  });
  if (error) console.error(`saveMistake: ${error.message}`);
  return !error;
}

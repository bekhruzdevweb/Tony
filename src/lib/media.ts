import "server-only";
import { randomUUID } from "node:crypto";
import type { Bot, InlineKeyboard } from "grammy";
import { requireDb } from "./db";
import { plain } from "./html";

/**
 * Tony's memory for photos, videos, documents and voice notes. Each item
 * keeps Telegram's file id (so the original can be sent back exactly), a
 * copy in a private storage bucket (so the app can show it), what he wrote
 * with it, and what Tony made of it.
 */
export type MediaKind = "photo" | "video" | "document" | "voice" | "audio" | "animation";

export type Media = {
  id: number;
  kind: MediaKind;
  file_id: string;
  file_unique_id: string | null;
  mime: string | null;
  caption: string | null;
  description: string | null;
  note: string | null;
  task_id: number | null;
  storage_path: string | null;
  signed_url: string | null;
  signed_until: string | null;
  created_at: string;
};

export const MEDIA_BUCKET = "tony-media";
/** How long a link to a stored copy works, and how early it is renewed. */
const LINK_SECONDS = 24 * 60 * 60;
const RENEW_BEFORE_MS = 2 * 60 * 60_000;
/** Telegram captions hold 1024 characters. */
const CAPTION_LIMIT = 1000;

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "application/pdf": "pdf" };

/** Records one item, copying the file to storage when its bytes are at hand. */
export async function saveMedia(input: {
  kind: MediaKind;
  fileId: string;
  uniqueId?: string;
  mime?: string;
  caption?: string;
  description?: string;
  bytes?: ArrayBuffer;
}): Promise<Media> {
  const db = requireDb();
  let storagePath: string | null = null;
  if (input.bytes) {
    const mime = input.mime ?? "application/octet-stream";
    // The path is random, so it cannot be guessed or collide.
    const path = `${input.kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${EXTENSION[mime] ?? "bin"}`;
    const { error } = await db.storage.from(MEDIA_BUCKET).upload(path, input.bytes, { contentType: mime, upsert: false });
    if (error) console.error(`saveMedia: the copy could not be stored: ${error.message}`);
    else storagePath = path;
  }
  const { data, error } = await db
    .from("media")
    .insert({
      kind: input.kind,
      file_id: input.fileId,
      file_unique_id: input.uniqueId ?? null,
      mime: input.mime ?? null,
      caption: input.caption?.slice(0, 2000) || null,
      description: input.description?.slice(0, 3000) || null,
      storage_path: storagePath,
    })
    .select()
    .single();
  if (error) throw new Error(`saveMedia: ${error.message}`);
  return data as Media;
}

export async function loadMedia(id: number): Promise<Media | undefined> {
  const { data, error } = await requireDb().from("media").select().eq("id", id).maybeSingle();
  if (error) throw new Error(`loadMedia: ${error.message}`);
  return (data as Media | null) ?? undefined;
}

export async function updateMedia(id: number, patch: Partial<Pick<Media, "task_id" | "note" | "description">>): Promise<void> {
  const { error } = await requireDb().from("media").update(patch).eq("id", id);
  if (error) throw new Error(`updateMedia: ${error.message}`);
}

/** The first thing attached to a task, if anything is. */
export async function mediaForTask(taskId: number): Promise<Media | undefined> {
  const { data, error } = await requireDb().from("media").select().eq("task_id", taskId).order("id").limit(1);
  if (error) throw new Error(`mediaForTask: ${error.message}`);
  return ((data ?? []) as Media[])[0];
}

/**
 * Finds saved items by what he called them, wrote with them, or what they
 * show: "video ideas" matches a note "video idea" or a caption mentioning it.
 */
export async function findMedia(query: string, limit = 5): Promise<Media[]> {
  const { data, error } = await requireDb().from("media").select().order("id", { ascending: false }).limit(300);
  if (error) throw new Error(`findMedia: ${error.message}`);
  // Words are compared by their first five letters, so "ideas" finds "idea".
  const stems = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((word) => word.slice(0, 5));
  const wanted = [...new Set(stems(query))].filter((stem) => !["show", "send", "find", "all", "the", "saved"].includes(stem));
  const scored = ((data ?? []) as Media[])
    .map((item) => {
      const strong = new Set(stems(`${item.note ?? ""} ${item.caption ?? ""} ${item.kind}`));
      const weak = new Set(stems(item.description ?? ""));
      const score = wanted.reduce((sum, stem) => sum + (strong.has(stem) ? 2 : weak.has(stem) ? 1 : 0), 0);
      return { item, score };
    })
    .filter((entry) => entry.score > 0 && (wanted.length === 0 || entry.score >= Math.min(2, wanted.length)));
  return scored.sort((x, y) => y.score - x.score || y.item.id - x.item.id).slice(0, limit).map((entry) => entry.item);
}

/** What to say under a saved item when it is sent back: his note, or his caption. */
export const mediaLabel = (item: Media) => item.note || item.caption || (item.description ? item.description.split("\n").pop()!.replace(/^Shows:\s*/, "") : `Saved ${item.kind}`);

/**
 * Sends the original back by its Telegram file id, with a formatted caption
 * and optional buttons. Returns the new message's id.
 */
export async function sendMedia(
  bot: Bot,
  chatId: number,
  item: Media,
  html: string,
  options: { keyboard?: InlineKeyboard; silent?: boolean } = {},
): Promise<number> {
  const signal = AbortSignal.timeout(15_000) as unknown as Parameters<typeof bot.api.sendPhoto>[3];
  const send = (caption: string, parse_mode?: "HTML") => {
    const other = { caption, parse_mode, reply_markup: options.keyboard, disable_notification: options.silent };
    switch (item.kind) {
      case "photo":
        return bot.api.sendPhoto(chatId, item.file_id, other, signal);
      case "video":
        return bot.api.sendVideo(chatId, item.file_id, other, signal);
      case "animation":
        return bot.api.sendAnimation(chatId, item.file_id, other, signal);
      case "voice":
        return bot.api.sendVoice(chatId, item.file_id, other, signal);
      case "audio":
        return bot.api.sendAudio(chatId, item.file_id, other, signal);
      default:
        return bot.api.sendDocument(chatId, item.file_id, other, signal);
    }
  };
  const caption = html.length > CAPTION_LIMIT ? `${plain(html).slice(0, CAPTION_LIMIT - 1)}…` : html;
  try {
    return (await send(caption, caption === html ? "HTML" : undefined)).message_id;
  } catch (error) {
    if (!/can't parse entities/i.test(String((error as { description?: string })?.description ?? error))) throw error;
    return (await send(plain(html).slice(0, CAPTION_LIMIT))).message_id;
  }
}

export type AppMediaItem = { id: number; task_id: number; kind: MediaKind; url: string | null; caption: string | null; description: string | null; note: string | null };

/**
 * Attachments of the given tasks, for the app. Links to the stored copies
 * last a day and are renewed here shortly before they run out, so reading
 * the app's state every few seconds does not create a new link each time.
 */
export async function mediaForApp(taskIds: number[], now = new Date()): Promise<AppMediaItem[]> {
  if (taskIds.length === 0) return [];
  const db = requireDb();
  const { data, error } = await db.from("media").select().in("task_id", taskIds).order("id").limit(200);
  if (error) throw new Error(`mediaForApp: ${error.message}`);
  const items = (data ?? []) as Media[];
  for (const item of items) {
    if (!item.storage_path) continue;
    const fresh = item.signed_url && item.signed_until && new Date(item.signed_until).getTime() - now.getTime() > RENEW_BEFORE_MS;
    if (fresh) continue;
    const signed = await db.storage.from(MEDIA_BUCKET).createSignedUrl(item.storage_path, LINK_SECONDS);
    if (signed.error || !signed.data) {
      console.error(`mediaForApp: ${signed.error?.message}`);
      continue;
    }
    item.signed_url = signed.data.signedUrl;
    item.signed_until = new Date(now.getTime() + LINK_SECONDS * 1000).toISOString();
    await db.from("media").update({ signed_url: item.signed_url, signed_until: item.signed_until }).eq("id", item.id);
  }
  return items.map((item) => ({ id: item.id, task_id: item.task_id!, kind: item.kind, url: item.signed_url, caption: item.caption, description: item.description, note: item.note }));
}

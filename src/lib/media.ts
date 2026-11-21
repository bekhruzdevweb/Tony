import "server-only";
import { isPromoCaption } from "./library-rules";
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
export type MediaKind = "photo" | "video" | "document" | "voice" | "audio" | "animation" | "video_note";

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
/** Every file kept with a task (a forwarded post's photos), in the order he sent them; voice notes are not examples. */
export async function mediaListForTask(taskId: number): Promise<Media[]> {
  const { data, error } = await requireDb().from("media").select().eq("task_id", taskId).order("id").limit(20);
  if (error) throw new Error(`mediaListForTask: ${error.message}`);
  return ((data ?? []) as Media[]).filter((item) => item.kind !== "voice" && item.kind !== "audio");
}

/**
 * A task's example sent back as he forwarded it: the photos and videos as one
 * album with the post's text, and the text in full after it when it is too
 * long for a caption (21 Nov: "keep the post with the task"). Only for an
 * example of two files or more, or a post's text kept with the task; a single
 * file stays the reminder itself. Returns whether anything was sent.
 */
export async function sendTaskExample(bot: Bot, chatId: number, taskId: number): Promise<boolean> {
  const files = await mediaListForTask(taskId);
  const posts = await requireDb().from("library").select("description").eq("task_id", taskId).eq("kind", "post").order("id").limit(3);
  const postText = ((posts.data ?? []) as { description: string | null }[]).map((row) => row.description?.trim()).filter(Boolean)[0];
  const text = files.map((item) => item.caption?.trim()).find((caption) => caption && !isPromoCaption(caption)) ?? postText;
  if (files.length < 2 && !(files.length === 0 && text)) return false;
  const album = files.filter((item) => item.kind === "photo" || item.kind === "video").slice(0, 10);
  const captioned = album.length >= 2 && text !== undefined && text.length <= CAPTION_LIMIT;
  if (album.length >= 2) {
    await bot.api.sendMediaGroup(
      chatId,
      album.map((item, index) => ({ type: item.kind as "photo" | "video", media: item.file_id, ...(index === 0 && captioned ? { caption: text } : {}) })),
      { disable_notification: true },
    );
  } else {
    for (const item of files.slice(0, 3)) await sendMedia(bot, chatId, item, "", { silent: true });
  }
  // The post's text: the album's caption when it fits, otherwise whole after it, in Telegram-sized pieces.
  if (text && !captioned) for (let at = 0; at < text.length; at += 4000) await bot.api.sendMessage(chatId, text.slice(at, at + 4000), { disable_notification: true });
  return true;
}

export async function mediaForTask(taskId: number): Promise<Media | undefined> {
  const { data, error } = await requireDb().from("media").select().eq("task_id", taskId).order("id").limit(1);
  if (error) throw new Error(`mediaForTask: ${error.message}`);
  return ((data ?? []) as Media[])[0];
}

/**
 * Finds saved items by what he called them, wrote with them, or what they
 * show: "video ideas" matches a note "video idea" or a caption mentioning it.
 */
/** He asked for a voice note or audio back in so many words ("send my voice note"). */
export const asksForVoiceBack = (text: string) => /\b(voice ?notes?|voice messages?|audio|recordings?)\b/i.test(text);

/**
 * He asked to see or get something back: a verb like send/show/forward
 * and a thing like photo/post/file/it. Only then are saved originals resent.
 */
/** "There was a picture of the website features", "where is the photo of…": he means one he sent before. */
export const pointsAtMedia = (text: string) =>
  /\b(there (was|is|were)|where('?s| is| are| was)|remember|looking for|i need|the one)\b[^.?!]{0,30}\b(photos?|pictures?|pics?|images?|screenshots?|files?|documents?|videos?)\b/i.test(text);

/** Any request to hand something over ("okay share iit with me", "yes send"), whatever the object is called. */
export const askedToSend = (text: string) => /\b(send|share|show|give|forward|resend|pass)\b/i.test(text);

export const asksForMedia = (text: string) =>
  /\b(send|show|resend|forward|give|find|share)\b/i.test(text) && /\b(photos?|pictures?|pics?|images?|screenshots?|files?|documents?|videos?|posts?|ideas?|voice ?notes?|audio|it|them|that|this|these)\b/i.test(text);

export async function findMedia(query: string, limit = 5, now = new Date()): Promise<Media[]> {
  const { data, error } = await requireDb().from("media").select().order("id", { ascending: false }).limit(300);
  if (error) throw new Error(`findMedia: ${error.message}`);
  // His own voice notes are never handed back unless he asks for a voice note by name,
  // and nothing he sent in the last two minutes (the message being answered) is a result.
  const voiceAllowed = asksForVoiceBack(query);
  const recent = now.getTime() - 2 * 60_000;
  const candidates = ((data ?? []) as Media[]).filter(
    (item) => (voiceAllowed || (item.kind !== "voice" && item.kind !== "audio")) && new Date(item.created_at).getTime() < recent,
  );
  // The task each one is attached to names it too ("the photo for adding this feature to my website").
  const taskIds = [...new Set(candidates.map((item) => item.task_id).filter((id): id is number => id !== null))];
  const titles = new Map<number, string>();
  if (taskIds.length > 0) {
    const tasks = await requireDb().from("tasks").select("id, title").in("id", taskIds);
    for (const row of (tasks.data ?? []) as { id: number; title: string }[]) titles.set(Number(row.id), row.title);
  }
  // Words are compared by their first five letters, so "ideas" finds "idea".
  const stems = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((word) => word.slice(0, 5));
  const wanted = [...new Set(stems(query))].filter((stem) => !["show", "send", "find", "all", "the", "saved", "this", "with", "you", "can", "rememb", "remem", "sent"].includes(stem));
  const scored = candidates
    .map((item) => {
      const strong = new Set(stems(`${item.note ?? ""} ${item.caption ?? ""} ${item.kind} ${item.task_id !== null ? (titles.get(Number(item.task_id)) ?? "") : ""}`));
      const weak = new Set(stems(item.description ?? ""));
      const score = wanted.reduce((sum, stem) => sum + (strong.has(stem) ? 2 : weak.has(stem) ? 1 : 0), 0);
      return { item, score };
    })
    .filter((entry) => entry.score > 0 && (wanted.length === 0 || entry.score >= Math.min(2, wanted.length)));
  return scored.sort((x, y) => y.score - x.score || y.item.id - x.item.id).slice(0, limit).map((entry) => entry.item);
}

/** What to say under a saved item when it is sent back: his note, or his caption. */
export const mediaLabel = (item: Media) =>
  item.note || (isPromoCaption(item.caption) ? undefined : item.caption) || (item.description ? item.description.split("\n").pop()!.replace(/^Shows:\s*/, "") : `Saved ${item.kind}`);

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
      case "video_note":
        // A round video takes no caption: it goes as it was sent.
        return bot.api.sendVideoNote(chatId, item.file_id, { reply_markup: options.keyboard, disable_notification: options.silent }, signal);
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

export type AttachmentCount = { photo: number; video: number; file: number };

/** Photos, videos and files attached to each task, for its receipt and for Tony's own list. */
export async function attachmentCounts(taskIds: number[]): Promise<Map<number, AttachmentCount>> {
  const counts = new Map<number, AttachmentCount>();
  if (taskIds.length === 0) return counts;
  const { data, error } = await requireDb().from("media").select("task_id, kind").in("task_id", taskIds);
  if (error) {
    console.error(`attachmentCounts: ${error.message}`);
    return counts;
  }
  for (const row of (data ?? []) as { task_id: number; kind: MediaKind }[]) {
    const count = counts.get(Number(row.task_id)) ?? { photo: 0, video: 0, file: 0 };
    if (row.kind === "photo" || row.kind === "animation") count.photo++;
    else if (row.kind === "video") count.video++;
    else if (row.kind === "document") count.file++;
    else continue;
    counts.set(Number(row.task_id), count);
  }
  return counts;
}

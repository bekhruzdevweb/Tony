import "server-only";
import { InputFile, type Bot } from "grammy";
import { requireDb } from "./db";
import { env } from "./env";
import { joinPcm, pcmToOggOpus, readWav } from "./ogg-opus";
import { localDate, minuteOfDay, TIMEZONE } from "./time";

/**
 * Tony's speaking voice. He speaks on two occasions only: in answer to a
 * voice note, and for the morning brief.
 *
 * ElevenLabs is the voice. If it fails for any reason (an outage, a
 * rejected key, credits run out), Orpheus on Groq speaks instead.
 *
 * Orpheus takes a vocal direction as a bracketed word at the start of the
 * text, such as [cheerful]. Directions are added here, to what is sent to
 * Orpheus, and nowhere else: the text message never contains one, and
 * ElevenLabs, which would read a bracketed word aloud, is never sent one.
 */
export type SpeechOccasion = "reply" | "completed" | "brief" | "coach" | "coach:firm" | "final";

/**
 * When Tony speaks (/voice on|off|auto):
 * - auto (the default): the morning brief, the coach's nudges that matter
 *   (a habit slipping, a key task due in 30 minutes and not started), and
 *   a reminder's final call after two were ignored; at most three a day.
 *   Replies to voice notes are text.
 * - on: all of that with no daily limit, and voice notes are answered aloud.
 * - off: never on his own.
 * Whatever the mode, when he asks for it ("say it", "voice", "tell me") he
 * gets it, and that one is not counted.
 */
export type VoiceMode = "on" | "off" | "auto";
export const DAILY_VOICE_LIMIT = 3;

type VoiceState = { mode: VoiceMode; day: string | null; count: number };

export async function voiceState(now = new Date()): Promise<VoiceState> {
  try {
    const { data, error } = await requireDb().from("settings").select("voice_mode, voice_day, voice_count").limit(1).maybeSingle();
    if (error || !data) return { mode: "auto", day: null, count: 0 };
    const row = data as { voice_mode: VoiceMode | null; voice_day: string | null; voice_count: number | null };
    const today = localDate(now);
    const sameDay = row.voice_day !== null && String(row.voice_day).slice(0, 10) === today;
    return { mode: row.voice_mode ?? "auto", day: today, count: sameDay ? Number(row.voice_count ?? 0) : 0 };
  } catch {
    return { mode: "auto", day: null, count: 0 };
  }
}

export async function setVoiceMode(mode: VoiceMode): Promise<void> {
  const { error } = await requireDb().from("settings").update({ voice_mode: mode }).eq("id", true);
  if (error) throw new Error(`setVoiceMode: ${error.message}`);
}

/** Whether this voice note may be sent, by the rules above. */
async function voiceAllowed(occasion: SpeechOccasion, asked: boolean, now: Date): Promise<{ ok: boolean; why?: string; state: VoiceState }> {
  const state = await voiceState(now);
  if (asked) return { ok: true, state };
  if (state.mode === "off") return { ok: false, why: "voice is off", state };
  const isReply = occasion === "reply" || occasion === "completed";
  if (isReply && state.mode !== "on") return { ok: false, why: "replies are text in auto mode", state };
  if (state.mode === "auto" && state.count >= DAILY_VOICE_LIMIT) return { ok: false, why: `${state.count} of ${DAILY_VOICE_LIMIT} voice notes already sent today`, state };
  return { ok: true, state };
}

async function countVoice(state: VoiceState, now: Date): Promise<void> {
  try {
    const { error } = await requireDb().from("settings").update({ voice_day: localDate(now), voice_count: state.count + 1 }).eq("id", true);
    if (error) console.error(`countVoice: ${error.message}`);
  } catch (error) {
    console.error("countVoice:", error);
  }
}

/** He asked to hear it: "say it", "voice", "tell me", "read it out", "out loud". */
export function asksForVoice(text: string): boolean {
  return /\b(say (it|that|this)|voice( note| message| reply)?|tell me|read (it|that|this|them) (out|aloud)|out loud|aloud)\b/i.test(text);
}

/** What he says aloud is short; the detail is in the text message. */
const MAX_SPOKEN = 300;
/** Orpheus accepts at most 200 characters per request, direction included. */
const MAX_INPUT = 200;
/** 300 characters, with a direction on each piece, fit in two requests. */
const MAX_CHUNKS = 2;
const NIGHT_FROM = 21 * 60;
const NIGHT_UNTIL = 7 * 60;

/**
 * How Tony should sound:
 * - after 21:00 (until 07:00): calm and soft, whatever the occasion;
 * - the morning brief and a completed task: cheerful;
 * - otherwise his ordinary voice, with no direction.
 */
export function vocalDirection(occasion: SpeechOccasion, now = new Date()): string | undefined {
  const minute = minuteOfDay(now, TIMEZONE);
  if (minute >= NIGHT_FROM || minute < NIGHT_UNTIL) return "calm";
  if (occasion === "coach:firm" || occasion === "final") return "firmly";
  if (occasion === "brief" || occasion === "completed" || occasion === "coach") return "cheerful";
  return undefined;
}

/** Plain words for a speech model: no markup, symbols, list bullets or bracketed directions. */
export function speakable(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    // A bracketed word or two is a vocal direction ([cheerful], [calm]); it is not to be read out.
    .replace(/\[[^\]\n]{0,40}\]/g, " ")
    .replace(/[[\]]/g, " ")
    .replace(/[•☐☑✓✅⚠️🔔📅🗓📥🌙📊➕☀️]/gu, " ")
    .replace(/&amp;/g, "and")
    .replace(/&lt;|&gt;/g, " ")
    .replace(/\s+/g, " ")
    // Removing markup can leave a space before a comma or full stop.
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
}

/**
 * The part of a reply that is said aloud: whole sentences from the start,
 * up to about 300 characters. The full reply is in the text message.
 */
export function spokenPart(text: string, limit = MAX_SPOKEN): string {
  const plain = speakable(text);
  if (plain.length <= limit) return plain;
  let out = "";
  for (const sentence of plain.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    if ((out + sentence).trimEnd().length > limit) break;
    out += sentence;
  }
  out = out.trim();
  // A first sentence longer than the limit is cut at a word.
  return out || `${plain.slice(0, plain.lastIndexOf(" ", limit - 1) || limit).replace(/[,;:]$/, "")}.`;
}

/** Splits text at sentence ends into pieces that each fit one request. */
export function speechChunks(text: string, direction?: string): string[] {
  const prefix = direction ? `[${direction}] ` : "";
  const room = MAX_INPUT - prefix.length;
  const sentences = speakable(text).match(/[^.!?]+[.!?]*\s*/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (current && `${current} ${piece}`.length > room) {
      chunks.push(current);
      current = "";
    }
    // A single sentence longer than the limit is cut at a word.
    current = current ? `${current} ${piece}` : piece.length > room ? piece.slice(0, piece.lastIndexOf(" ", room - 1) || room) : piece;
    if (chunks.length === MAX_CHUNKS) break;
  }
  if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
  // Each piece is its own request, so each carries the direction.
  return chunks.map((chunk) => `${prefix}${chunk}`);
}

/** Orpheus on Groq: WAV in pieces, joined and encoded here. */
async function orpheus(text: string, direction?: string): Promise<Uint8Array> {
  const clips = [];
  for (const input of speechChunks(text, direction)) {
    const response = await fetch(`${env.sttBaseUrl}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.sttApiKey}` },
      body: JSON.stringify({ model: env.ttsModel, voice: env.ttsVoice, input, response_format: "wav" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Orpheus answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    }
    clips.push(readWav(new Uint8Array(await response.arrayBuffer())));
  }
  if (clips.length === 0) throw new Error("nothing to say");
  // Telegram shows a voice bubble only for OGG/Opus.
  return pcmToOggOpus(joinPcm(clips));
}

async function elevenLabsRequest(text: string, format: string): Promise<Uint8Array> {
  const response = await fetch(`${env.elevenLabsBaseUrl}/v1/text-to-speech/${encodeURIComponent(env.elevenLabsVoiceId!)}?output_format=${format}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": env.elevenLabsApiKey! },
    body: JSON.stringify({ text, model_id: env.elevenLabsModel }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
  }
  const audio = new Uint8Array(await response.arrayBuffer());
  // Every character ElevenLabs speaks counts against the month's quota.
  await recordUsage(text.length);
  return audio;
}

/** The month the usage count belongs to (YYYY-MM, Tashkent time). */
const monthOf = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit" }).format(at);

/** Adds characters to this month's ElevenLabs count. Never throws. */
async function recordUsage(chars: number, now = new Date()): Promise<void> {
  try {
    const db = requireDb();
    const { data, error } = await db.from("settings").select("tts_month, tts_chars").limit(1).maybeSingle();
    if (error) return console.error(`recordUsage: ${error.message}`);
    const row = data as { tts_month: string | null; tts_chars: number | null } | null;
    const month = monthOf(now);
    const used = row?.tts_month === month ? Number(row.tts_chars ?? 0) : 0;
    const update = await db.from("settings").update({ tts_month: month, tts_chars: used + chars }).eq("id", true);
    if (update.error) console.error(`recordUsage: ${update.error.message}`);
  } catch (error) {
    console.error("recordUsage:", error);
  }
}

export type VoiceBudget = { used: number; limit: number; share: number; source: "elevenlabs" | "counted" };
let planCache: { at: number; used: number; limit: number } | undefined;
const PLAN_CACHE_MS = 10 * 60_000;
/** Above this share of the month's characters, only the morning brief is spoken. */
export const VOICE_BUDGET_SHARE = 0.8;

/**
 * How much of the month's ElevenLabs characters are used. The plan's own
 * figures when the key may read them (they include anything spoken outside
 * Tony); otherwise Tony's own count against ELEVENLABS_MONTHLY_CHARS.
 */
export async function voiceBudget(now = new Date()): Promise<VoiceBudget> {
  let counted = 0;
  try {
    const { data } = await requireDb().from("settings").select("tts_month, tts_chars").limit(1).maybeSingle();
    const row = data as { tts_month: string | null; tts_chars: number | null } | null;
    counted = row?.tts_month === monthOf(now) ? Number(row.tts_chars ?? 0) : 0;
  } catch {
    counted = 0;
  }
  if (env.elevenLabsApiKey) {
    if (!planCache || Date.now() - planCache.at > PLAN_CACHE_MS) {
      try {
        const response = await fetch(`${env.elevenLabsBaseUrl}/v1/user/subscription`, { headers: { "xi-api-key": env.elevenLabsApiKey }, signal: AbortSignal.timeout(4_000) });
        if (response.ok) {
          const plan = (await response.json()) as { character_count?: number; character_limit?: number };
          if (typeof plan.character_count === "number" && typeof plan.character_limit === "number" && plan.character_limit > 0) {
            planCache = { at: Date.now(), used: plan.character_count, limit: plan.character_limit };
          }
        }
      } catch {
        // Not readable: Tony's own count is used.
      }
    }
    if (planCache) {
      const used = Math.max(planCache.used, counted);
      return { used, limit: planCache.limit, share: used / planCache.limit, source: "elevenlabs" };
    }
  }
  const limit = env.elevenLabsMonthlyChars;
  return { used: counted, limit, share: counted / limit, source: "counted" };
}

const PCM_RATE = 24_000;

/**
 * ElevenLabs: asked for Opus, which Telegram takes as it is when it comes
 * in an Ogg stream. If what comes back is not an Ogg stream, the same text
 * is asked for as plain samples and encoded here.
 */
async function elevenLabs(text: string): Promise<Uint8Array> {
  const opus = await elevenLabsRequest(text, "opus_48000_32");
  if (opus.length > 4 && String.fromCharCode(...opus.subarray(0, 4)) === "OggS") return opus;
  console.warn("ElevenLabs did not send an Ogg stream for Opus; asking for samples instead.");
  const raw = await elevenLabsRequest(text, `pcm_${PCM_RATE}`);
  // 16-bit little-endian mono samples.
  const samples = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.byteLength & ~1)));
  return pcmToOggOpus({ samples, sampleRate: PCM_RATE, channels: 1 });
}

/** Whether Tony has a voice at all. */
export function canSpeak(): boolean {
  return Boolean((env.elevenLabsApiKey && env.elevenLabsVoiceId) || (env.ttsModel && env.sttApiKey));
}

/**
 * Says `text` aloud in the chat as a voice note. Returns the message id, or
 * undefined when he has no voice or anything goes wrong: the text message
 * has already been sent, so a missing voice note loses nothing.
 */
export async function sayAloud(
  bot: Bot,
  chatId: number,
  text: string,
  occasion: SpeechOccasion,
  options: { now?: Date; silent?: boolean; caption?: string; asked?: boolean } = {},
): Promise<number | undefined> {
  if (!canSpeak()) return undefined;
  try {
    const words = spokenPart(text);
    if (!words) return undefined;
    const now = options.now ?? new Date();
    const asked = options.asked ?? false;
    const allowed = await voiceAllowed(occasion, asked, now);
    if (!allowed.ok) {
      console.log(`Not spoken (${occasion}): ${allowed.why}.`);
      return undefined;
    }
    // Past 80% of the month's characters, only the morning brief (and what he asks for) is spoken.
    if (occasion !== "brief" && !asked && env.elevenLabsApiKey && env.elevenLabsVoiceId) {
      const budget = await voiceBudget(options.now);
      if (budget.share >= VOICE_BUDGET_SHARE) {
        console.warn(`Voice kept for the morning brief: ${budget.used} of ${budget.limit} ElevenLabs characters used this month (${budget.source}).`);
        return undefined;
      }
    }
    let voice: Uint8Array | undefined;
    if (env.elevenLabsApiKey && env.elevenLabsVoiceId) {
      try {
        voice = await elevenLabs(words);
      } catch (error) {
        console.error(`ElevenLabs failed${env.ttsModel && env.sttApiKey ? ", using Orpheus" : ""}:`, error instanceof Error ? error.message : error);
      }
    }
    if (!voice) {
      if (!env.ttsModel || !env.sttApiKey) return undefined;
      voice = await orpheus(words, vocalDirection(occasion, options.now));
    }
    const sent = await bot.api.sendVoice(chatId, new InputFile(voice, "tony.ogg"), {
      disable_notification: options.silent,
      ...(options.caption ? { caption: options.caption.slice(0, 1024), parse_mode: "HTML" as const } : {}),
    });
    // Counted towards the day's three, unless he asked for it.
    if (!asked) await countVoice(allowed.state, now);
    return sent.message_id;
  } catch (error) {
    console.error("Spoken message failed:", error);
    return undefined;
  }
}

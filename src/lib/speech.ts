import "server-only";
import { InputFile, type Bot } from "grammy";
import { env } from "./env";
import { joinPcm, pcmToOggOpus, readWav } from "./ogg-opus";
import { minuteOfDay, TIMEZONE } from "./time";

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
export type SpeechOccasion = "reply" | "completed" | "brief";

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
  if (occasion === "brief" || occasion === "completed") return "cheerful";
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
  return new Uint8Array(await response.arrayBuffer());
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
  options: { now?: Date; silent?: boolean } = {},
): Promise<number | undefined> {
  if (!canSpeak()) return undefined;
  try {
    const words = spokenPart(text);
    if (!words) return undefined;
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
    const sent = await bot.api.sendVoice(chatId, new InputFile(voice, "tony.ogg"), { disable_notification: options.silent });
    return sent.message_id;
  } catch (error) {
    console.error("Spoken message failed:", error);
    return undefined;
  }
}

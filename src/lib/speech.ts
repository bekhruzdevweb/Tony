import "server-only";
import { InputFile, type Bot } from "grammy";
import { env } from "./env";
import { joinPcm, pcmToOggOpus, readWav } from "./ogg-opus";
import { minuteOfDay, TIMEZONE } from "./time";

/**
 * Tony's speaking voice. The speech model (Orpheus on Groq) takes a vocal
 * direction as a bracketed word or two at the start of the text, such as
 * [cheerful] or [whisper]. Directions are added here, to what is sent to the
 * speech model, and nowhere else: the text message never contains one.
 */
export type SpeechOccasion = "reply" | "completed" | "brief" | "nudge";

/** Orpheus accepts at most 200 characters per request, direction included. */
const MAX_INPUT = 200;
/** Enough for a reply of lock-screen length; longer text is cut at a sentence. */
const MAX_CHUNKS = 3;
const NIGHT_FROM = 21 * 60;
const NIGHT_UNTIL = 7 * 60;

/**
 * How Tony should sound:
 * - after 21:00 (until 07:00): calm and soft, whatever the occasion;
 * - a persistent reminder from its third nudge on: firmer;
 * - the morning brief and a completed task: cheerful;
 * - otherwise his ordinary voice, with no direction.
 */
export function vocalDirection(occasion: SpeechOccasion, now = new Date(), nudgeNumber = 1): string | undefined {
  const minute = minuteOfDay(now, TIMEZONE);
  if (minute >= NIGHT_FROM || minute < NIGHT_UNTIL) return "calm";
  if (occasion === "nudge" && nudgeNumber > 2) return "firmly";
  if (occasion === "brief" || occasion === "completed") return "cheerful";
  return undefined;
}

/** Plain words for the speech model: no markup, symbols or list bullets. */
function speakable(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    // A bracket in the text would be taken as a direction; none of Tony's own text should carry one.
    .replace(/[[\]]/g, " ")
    .replace(/[•☐☑✓✅⚠️🔔📅🗓📥🌙📊➕☀️]/gu, " ")
    .replace(/&amp;/g, "and")
    .replace(/&lt;|&gt;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function synthesise(input: string): Promise<Uint8Array> {
  const response = await fetch(`${env.sttBaseUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.sttApiKey}` },
    body: JSON.stringify({ model: env.ttsModel, voice: env.ttsVoice, input, response_format: "wav" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Text-to-speech answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Says `text` aloud in the chat as a voice note. Returns the message id, or
 * undefined when speech is switched off or anything goes wrong: the text
 * message has already been sent, so a missing voice note loses nothing.
 */
export async function sayAloud(
  bot: Bot,
  chatId: number,
  text: string,
  occasion: SpeechOccasion,
  options: { now?: Date; nudgeNumber?: number; silent?: boolean } = {},
): Promise<number | undefined> {
  if (!env.ttsModel || !env.sttApiKey) return undefined;
  try {
    const chunks = speechChunks(text, vocalDirection(occasion, options.now, options.nudgeNumber));
    if (chunks.length === 0) return undefined;
    const clips = [];
    for (const chunk of chunks) clips.push(readWav(await synthesise(chunk)));
    // Telegram shows a voice bubble only for OGG/Opus; the speech service sends WAV.
    const voice = pcmToOggOpus(joinPcm(clips));
    const sent = await bot.api.sendVoice(chatId, new InputFile(voice, "tony.ogg"), { disable_notification: options.silent });
    return sent.message_id;
  } catch (error) {
    console.error("Spoken message failed:", error);
    return undefined;
  }
}

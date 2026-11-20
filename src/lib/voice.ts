import "server-only";
import type { Bot } from "grammy";
import { env } from "./env";
import { allowedLanguage, bestTranscript, type Transcript } from "./brain/reliability";

/** Telegram lets a bot download files up to 20 MB; a voice note is far smaller. */
const MAX_BYTES = 20 * 1024 * 1024;
/** Ten minutes is a speech, not a task. */
export const MAX_VOICE_SECONDS = 600;

export class VoiceError extends Error {}

/** Fetches a file the user sent to the bot. */
export async function downloadTelegramFile(bot: Bot, fileId: string): Promise<{ bytes: ArrayBuffer; name: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new VoiceError("Telegram gave no file path");
  if ((file.file_size ?? 0) > MAX_BYTES) throw new VoiceError("File too large");

  const root = env.telegramApiRoot ?? "https://api.telegram.org";
  const response = await fetch(`${root}/file/bot${bot.token}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new VoiceError(`Telegram file download answered ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new VoiceError("File too large");
  return { bytes, name: file.file_path.split("/").pop() || "voice.oga" };
}

/** The languages he speaks to Tony in. Whisper may hear anything else in a short note (22:57: "Hungarian"). */
const SPOKEN = ["en", "uz", "ru"] as const;

type Reading = { text: string; language?: string; logprob: number };

/** One pass of the transcription API; `language` forces the language instead of letting it guess. */
async function transcribeOnce(bytes: ArrayBuffer, name: string, type: string, language?: string): Promise<Reading> {
  const apiKey = env.sttApiKey;
  if (!apiKey) throw new VoiceError("No speech-to-text key is set");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  form.append("model", env.sttModel);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (language) form.append("language", language);

  let response: Response;
  try {
    response = await fetch(`${env.sttBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new VoiceError(`Speech-to-text unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new VoiceError(`Speech-to-text answered ${response.status}: ${detail}`);
  }
  const body = (await response.json()) as { text?: string; language?: string; segments?: { avg_logprob?: number }[] };
  const scores = (body.segments ?? []).map((segment) => segment.avg_logprob).filter((score): score is number => typeof score === "number");
  return { text: (body.text ?? "").trim(), language: body.language ?? language, logprob: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : -1 };
}

/**
 * Audio to text, through an OpenAI-compatible transcription API, in English,
 * Uzbek or Russian only. The language is detected first; if the guess is any
 * other language, the note is read again as each of the three and the most
 * confident reading wins.
 */
export async function transcribeAudio(bytes: ArrayBuffer, name: string, type: string): Promise<string> {
  if (bytes.byteLength > MAX_BYTES) throw new VoiceError("File too large");
  const first = await transcribeOnce(bytes, name, type);
  // No language reported (another provider): nothing to check.
  if (!first.language || allowedLanguage(first.language)) return first.text;
  console.warn(`Voice note heard as "${first.language}"; reading it again as English, Uzbek and Russian.`);
  const readings = await Promise.all(
    SPOKEN.map((language) =>
      transcribeOnce(bytes, name, type, language).then(
        (reading): Transcript => ({ language, text: reading.text, logprob: reading.logprob }),
        () => undefined,
      ),
    ),
  );
  return bestTranscript(readings.filter((reading): reading is Transcript => reading !== undefined))?.text ?? first.text;
}

/** A Telegram voice note to text. */
export async function transcribeVoice(bot: Bot, fileId: string): Promise<string> {
  const { bytes, name } = await downloadTelegramFile(bot, fileId);
  // Telegram names voice notes .oga; transcription services expect .ogg for the same Opus audio.
  return transcribeAudio(bytes, name.replace(/\.oga$/i, ".ogg"), "audio/ogg");
}

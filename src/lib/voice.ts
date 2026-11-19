import "server-only";
import type { Bot } from "grammy";
import { env } from "./env";

/** Telegram lets a bot download files up to 20 MB; a voice note is far smaller. */
const MAX_BYTES = 20 * 1024 * 1024;
/** Ten minutes is a speech, not a task. */
export const MAX_VOICE_SECONDS = 600;

export class VoiceError extends Error {}

/** Fetches a file the user sent to the bot. */
async function downloadTelegramFile(bot: Bot, fileId: string): Promise<{ bytes: ArrayBuffer; name: string }> {
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

/**
 * Audio to text, through an OpenAI-compatible transcription API. The
 * language is left for the model to detect, so Uzbek and Russian notes are
 * understood as well as English ones.
 */
export async function transcribeAudio(bytes: ArrayBuffer, name: string, type: string): Promise<string> {
  const apiKey = env.sttApiKey;
  if (!apiKey) throw new VoiceError("No speech-to-text key is set");
  if (bytes.byteLength > MAX_BYTES) throw new VoiceError("File too large");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  form.append("model", env.sttModel);
  form.append("response_format", "json");
  form.append("temperature", "0");

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
  const body = (await response.json()) as { text?: string };
  return (body.text ?? "").trim();
}

/** A Telegram voice note to text. */
export async function transcribeVoice(bot: Bot, fileId: string): Promise<string> {
  const { bytes, name } = await downloadTelegramFile(bot, fileId);
  // Telegram names voice notes .oga; transcription services expect .ogg for the same Opus audio.
  return transcribeAudio(bytes, name.replace(/\.oga$/i, ".ogg"), "audio/ogg");
}

/**
 * Text to speech, for answering a voice note aloud. Returns undefined when
 * spoken replies are switched off (no TTS_MODEL).
 */
export async function speak(text: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const model = env.ttsModel;
  const apiKey = env.sttApiKey;
  if (!model || !apiKey) return undefined;
  const response = await fetch(`${env.sttBaseUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, voice: env.ttsVoice, input: text.slice(0, 600), response_format: "wav" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new VoiceError(`Text-to-speech answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "audio/wav" };
}

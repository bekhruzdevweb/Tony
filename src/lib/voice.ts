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
 * Voice note to text, through an OpenAI-compatible transcription API. The
 * language is left for the model to detect, so Uzbek and Russian notes are
 * understood as well as English ones.
 */
export async function transcribeVoice(bot: Bot, fileId: string): Promise<string> {
  const apiKey = env.sttApiKey;
  if (!apiKey) throw new VoiceError("No speech-to-text key is set");

  const { bytes, name } = await downloadTelegramFile(bot, fileId);
  const form = new FormData();
  // Telegram names voice notes .oga; transcription services expect .ogg for the same Opus audio.
  form.append("file", new Blob([bytes], { type: "audio/ogg" }), name.replace(/\.oga$/i, ".ogg"));
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

import "server-only";

/** Empty strings count as unset, which is how Vercel stores a cleared value. */
function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const env = {
  get telegramBotToken() {
    return read("TELEGRAM_BOT_TOKEN");
  },
  get telegramWebhookSecret() {
    return read("TELEGRAM_WEBHOOK_SECRET");
  },
  get telegramOwnerId() {
    const raw = read("TELEGRAM_OWNER_ID");
    const id = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(id) ? id : undefined;
  },
  /** Only for tests: point the bot at a stand-in for api.telegram.org. */
  get telegramApiRoot() {
    return read("TELEGRAM_API_ROOT");
  },
  /** Any OpenAI-compatible chat API. The model is one swappable setting. */
  get aiApiKey() {
    return read("AI_API_KEY");
  },
  get aiBaseUrl() {
    return (read("AI_BASE_URL") ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  },
  get aiModel() {
    return read("AI_MODEL") ?? "openai/gpt-oss-120b";
  },
  /** Speech-to-text. Defaults to the same provider and key as the brain. */
  get sttApiKey() {
    return read("STT_API_KEY") ?? read("AI_API_KEY");
  },
  get sttBaseUrl() {
    return (read("STT_BASE_URL") ?? read("AI_BASE_URL") ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  },
  get sttModel() {
    return read("STT_MODEL") ?? "whisper-large-v3";
  },
  /** Spoken replies: off unless TTS_MODEL is set. */
  get ttsModel() {
    return read("TTS_MODEL");
  },
  get ttsVoice() {
    return read("TTS_VOICE") ?? "daniel";
  },
  get supabaseUrl() {
    return read("SUPABASE_URL");
  },
  get supabaseSecretKey() {
    return read("SUPABASE_SECRET_KEY");
  },
};

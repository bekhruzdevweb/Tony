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
  /** Tony's main brain: Claude, through the Anthropic API. */
  get anthropicApiKey() {
    return read("ANTHROPIC_API_KEY");
  },
  /** How long Tony waits after his last message before answering, so messages sent together are one request (phase b). */
  get burstQuietMs() {
    const value = Number(read("BURST_QUIET_MS"));
    return Number.isFinite(value) && value >= 0 ? value : 4_000;
  },
  get anthropicModel() {
    return read("ANTHROPIC_MODEL") ?? "claude-haiku-5-5";
  },
  /** The larger model, for multi-step turns (several requests, moving or planning things). */
  get anthropicDeepModel() {
    return read("ANTHROPIC_DEEP_MODEL") ?? "claude-sonnet-5-5";
  },
  /** How hard Claude thinks before answering: low, medium, high, xhigh or max. */
  get anthropicEffort(): "low" | "medium" | "high" | "xhigh" | "max" {
    const value = read("ANTHROPIC_EFFORT")?.toLowerCase();
    return value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : "low";
  },
  /**
   * Groq: the voice (Whisper and Orpheus) and the brain's fallback. The key
   * was first called AI_API_KEY, and that name still works.
   */
  get aiApiKey() {
    return read("GROQ_API_KEY") ?? read("AI_API_KEY");
  },
  get aiBaseUrl() {
    return (read("AI_BASE_URL") ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  },
  /** The fallback brain, used when Claude cannot answer. */
  get aiModel() {
    return read("AI_MODEL") ?? "openai/gpt-oss-120b";
  },
  /**
   * Used when the Groq model itself is out of its per-minute allowance.
   * Limits are per model, so a second model is a second allowance. Set to
   * "none" to switch it off.
   */
  get aiFallbackModel() {
    const value = read("AI_FALLBACK_MODEL");
    if (value) return value.toLowerCase() === "none" ? undefined : value;
    // The default only makes sense on the default provider.
    return read("AI_BASE_URL") ? undefined : "openai/gpt-oss-20b";
  },
  /** Optional: "low", "medium" or "high", for models that reason before answering. */
  get aiReasoningEffort() {
    return read("AI_REASONING_EFFORT");
  },
  /** Test aid: look for a suggestion on every tick instead of every quarter of an hour. */
  get suggestEveryTick() {
    return read("TONY_SUGGEST_EVERY_TICK") === "1";
  },
  /** The fallback for reading images, on Groq, when Claude cannot. */
  get visionModel() {
    return read("VISION_MODEL") ?? "qwen/qwen3.8-27b";
  },
  /** Speech-to-text. Defaults to the same provider and key as the brain. */
  get sttApiKey() {
    return read("STT_API_KEY") ?? read("GROQ_API_KEY") ?? read("AI_API_KEY");
  },
  get sttBaseUrl() {
    return (read("STT_BASE_URL") ?? read("AI_BASE_URL") ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  },
  get sttModel() {
    return read("STT_MODEL") ?? "whisper-large-v3";
  },
  /** ElevenLabs: cut off on 21 Nov at his request. The voice is Groq's; set VOICE_ELEVENLABS=on to bring it back. */
  get elevenLabsApiKey() {
    return read("VOICE_ELEVENLABS") === "on" ? read("ELEVENLABS_API_KEY") : undefined;
  },
  get elevenLabsVoiceId() {
    return read("ELEVENLABS_VOICE_ID");
  },
  get elevenLabsModel() {
    return read("ELEVENLABS_MODEL") ?? "eleven_flash_v2_5";
  },
  /**
   * Characters a month on the ElevenLabs plan, used when the plan itself
   * cannot be read (the key may not be allowed to). Free plan: 10,000.
   */
  get elevenLabsMonthlyChars() {
    const value = Number(read("ELEVENLABS_MONTHLY_CHARS"));
    return Number.isFinite(value) && value > 0 ? value : 10_000;
  },
  get elevenLabsBaseUrl() {
    return (read("ELEVENLABS_BASE_URL") ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  },
  /** The fallback voice: Orpheus on Groq. "none" switches it off. */
  get ttsModel() {
    const value = read("TTS_MODEL") ?? "canopylabs/orpheus-v1-english";
    return value.toLowerCase() === "none" ? undefined : value;
  },
  get ttsVoice() {
    return read("TTS_VOICE") ?? "daniel";
  },
  /** Aladhan, for prayer times (overridable for tests). */
  get prayerApiBase() {
    return (read("PRAYER_API_BASE") ?? "https://api.aladhan.com").replace(/\/+$/, "");
  },
  /** The Muslim Board's prayer times site (overridable for tests). */
  get prayerSiteBase() {
    return (read("PRAYER_SITE_BASE") ?? "https://namoz-vaqti.uz").replace(/\/+$/, "");
  },
  get supabaseUrl() {
    return read("SUPABASE_URL");
  },
  get supabaseSecretKey() {
    return read("SUPABASE_SECRET_KEY");
  },
};

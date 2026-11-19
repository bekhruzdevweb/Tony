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
  get supabaseUrl() {
    return read("SUPABASE_URL");
  },
  get supabaseSecretKey() {
    return read("SUPABASE_SECRET_KEY");
  },
};

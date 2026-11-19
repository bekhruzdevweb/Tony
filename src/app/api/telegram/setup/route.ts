import { timingSafeEqual } from "node:crypto";
import { getBot } from "@/lib/bot";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { updateSettings } from "@/lib/settings";

function matches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Open once after each deploy to a new address:
 *   /api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
 * It points the bot's webhook at this deployment.
 */
export async function GET(request: Request) {
  const bot = getBot();
  const secretToken = env.telegramWebhookSecret;
  if (!bot || !secretToken) {
    return Response.json(
      { ok: false, error: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET, then redeploy." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  if (!matches(url.searchParams.get("secret") ?? "", secretToken)) {
    return Response.json({ ok: false, error: "Wrong secret." }, { status: 401 });
  }

  const webhookUrl = `${url.origin}/api/telegram/webhook`;
  try {
    await bot.api.setWebhook(webhookUrl, {
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
    });
    await bot.api.setMyCommands([
      { command: "today", description: "What is due today" },
      { command: "inbox", description: "Tasks without a date" },
      { command: "app", description: "Get a key to open the app" },
      { command: "ping", description: "Check that Tony is awake" },
    ]);
    // Tell the reminder clock in the database where this deployment lives.
    if (getDb()) await updateSettings({ app_url: url.origin });
    const me = await bot.api.getMe();
    return Response.json({ ok: true, bot: `@${me.username}`, webhook: webhookUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}

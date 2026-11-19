import { webhookCallback } from "grammy";
import { getBot } from "@/lib/bot";
import { env } from "@/lib/env";

/** Telegram calls this for every message and button tap. */
export async function POST(request: Request) {
  const bot = getBot();
  const secretToken = env.telegramWebhookSecret;
  if (!bot || !secretToken) {
    return Response.json({ error: "Telegram is not configured" }, { status: 503 });
  }
  // Rejects with 401 unless Telegram's secret header matches.
  return webhookCallback(bot, "std/http", { secretToken })(request);
}

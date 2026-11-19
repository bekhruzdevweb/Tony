import { timingSafeEqual } from "node:crypto";
import type { Update } from "grammy/types";
import { after } from "next/server";
import { getBot } from "@/lib/bot";
import { env } from "@/lib/env";

// Room for the AI model to think; Telegram itself is answered at once.
export const maxDuration = 60;

function matches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Telegram calls this for every message and button tap. The update is
 * acknowledged straight away and handled after the response, so a slow model
 * reply can never make Telegram time out and deliver the message twice.
 */
export async function POST(request: Request) {
  const bot = getBot();
  const secretToken = env.telegramWebhookSecret;
  if (!bot || !secretToken) {
    return Response.json({ error: "Telegram is not configured" }, { status: 503 });
  }
  if (!matches(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secretToken)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  await bot.init();
  after(async () => {
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      console.error("Update failed:", error);
    }
  });
  return Response.json({ ok: true });
}

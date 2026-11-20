import { timingSafeEqual } from "node:crypto";
import type { Update } from "grammy/types";
import { after } from "next/server";
import { getBot, type TonyBot } from "@/lib/bot";
import { burstable, holdForBurst, takeBurst } from "@/lib/burst";
import { firstSight } from "@/lib/dedupe";
import { env } from "@/lib/env";
import { refreshBoard } from "@/lib/today-board";

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

  // Telegram sometimes delivers an update more than once; act on it only the first time.
  if (!(await firstSight(update.update_id))) return Response.json({ ok: true, duplicate: true });

  await bot.init();
  after(async () => {
    try {
      // The burst rule (phase b): a message waits a few quiet seconds; the last of a burst answers for all of them.
      if (burstable(update) && (await holdForBurst(update))) {
        await bot.api.sendChatAction(update.message!.chat.id, "typing").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, env.burstQuietMs));
        const groups = await takeBurst(update);
        for (const group of groups ?? []) {
          if (group.length === 1 || !(bot as TonyBot).burst) for (const one of group) await bot.handleUpdate(one);
          else await (bot as TonyBot).burst!(group);
        }
      } else {
        await bot.handleUpdate(update);
      }
    } catch (error) {
      console.error("Update failed:", error);
    }
    // Whatever just happened may have changed today's list.
    const ownerId = env.telegramOwnerId;
    if (ownerId !== undefined) await refreshBoard(bot, ownerId);
  });
  return Response.json({ ok: true });
}

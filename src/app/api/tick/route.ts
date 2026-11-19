import { timingSafeEqual } from "node:crypto";
import { getBot } from "@/lib/bot";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { runTick } from "@/lib/reminders";
import { getSettings } from "@/lib/settings";

export const maxDuration = 30;

function matches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The reminder clock. The database calls this once a minute and presents the
 * password it generated for itself (settings.tick_secret).
 */
export async function POST(request: Request) {
  const bot = getBot();
  const chatId = env.telegramOwnerId;
  if (!bot || chatId === undefined || !getDb()) {
    return Response.json({ ok: false, error: "Tony is not fully configured" }, { status: 503 });
  }

  try {
    const { tick_secret } = await getSettings();
    const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!tick_secret || !matches(given, tick_secret)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return Response.json({ ok: true, ...(await runTick(bot, chatId)) });
  } catch (error) {
    console.error("Tick failed:", error);
    return Response.json({ ok: false, error: "Tick failed" }, { status: 500 });
  }
}

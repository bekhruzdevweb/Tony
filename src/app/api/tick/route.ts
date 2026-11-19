import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { getBot } from "@/lib/bot";
import { runBriefs } from "@/lib/briefs";
import { runSuggestions } from "@/lib/suggest";
import { runCleanup } from "@/lib/chat-log";
import { getDb } from "@/lib/db";
import { pruneUpdates } from "@/lib/dedupe";
import { env } from "@/lib/env";
import { runTick } from "@/lib/reminders";
import { getSettings } from "@/lib/settings";
import { sweepOnceAfterDeploy } from "@/lib/sweep";
import { refreshBoard } from "@/lib/today-board";

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
    const result = await runTick(bot, chatId, new Date(), {
      // Briefs first, then at most one unprompted suggestion.
      briefs: async (settings, now) => {
        const briefs = await runBriefs(bot, chatId, settings, now);
        if (briefs === 0) await runSuggestions(bot, chatId, settings, now);
      },
    });
    // A reminder, a brief or a rolled-over task may have changed today's list.
    await refreshBoard(bot, chatId);
    // Once an hour, forget update ids too old for Telegram to resend.
    if (new Date().getMinutes() === 7) await pruneUpdates().catch(() => undefined);
    // Last, tidy the chat: remove messages whose time has come.
    const cleaned = await runCleanup(bot, chatId).catch((error) => (console.error("Cleanup failed:", error), undefined));
    // Once after a deployment, a full sweep of the chat. After the answer, so the clock is not kept waiting.
    after(() => sweepOnceAfterDeploy(bot, chatId).catch((error) => console.error("One-time sweep failed:", error)));
    return Response.json({ ok: true, ...result, cleaned: cleaned?.deleted ?? 0 });
  } catch (error) {
    console.error("Tick failed:", error);
    return Response.json({ ok: false, error: "Tick failed" }, { status: 500 });
  }
}

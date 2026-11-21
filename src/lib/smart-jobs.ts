import "server-only";
import { InlineKeyboard, type Bot } from "grammy";
import { sendHtml, track } from "./chat-log";
import { env } from "./env";
import { logEvent } from "./events";
import { countFreeTime, shouldSuggestFreeTime, suggestFreeTime } from "./free-time";
import { noteFollowUp, sameDayFollowUp, weeklyInboxReview, type Row } from "./followups";
import { esc, plain } from "./html";
import type { LibraryItem } from "./library-rules";
import { loadMedia, mediaCaption, needsReading, rereadDocument, sendMedia } from "./media";
import { readableDocument } from "./vision";
import { mainPriorityNudge } from "./main-priority";
import { weeklyMemoryReview } from "./memory-review";
import { logMessage } from "./messages";
import { markdownToHtml } from "./rich";
import { runRuleChecks } from "./rules";
import { budgetLeft, budgetWarnings, dueToday, notify, runBackup } from "./safety";
import { selfTest, selfTestAlert } from "./selftest";
import type { Settings } from "./settings";
import { pruneIncoming } from "./burst";
import { inWindow, TIMEZONE } from "./time";
import { connectTelegram } from "./telegram-setup";
import { requireDb } from "./db";

/**
 * Phases c–e on the minute tick (21 Nov): his main priority's chase (22 Nov), the same-day follow-up, a rule
 * that fires on its own, a free-time suggestion, Sunday's inbox review and
 * memory review (21:30), and the daily jobs (backup 03:00, self-test 07:00,
 * budget guard 09:00). Unasked
 * messages respect quiet hours and the day's budget; at most one of them per
 * tick. Each job is noted in `events` and never stops the reminders.
 */

const keyboardOf = (rows: Row[]) => {
  const keyboard = new InlineKeyboard();
  rows.forEach((row, index) => {
    if (index > 0) keyboard.row();
    // "url:<address>" is a link button (the reel a follow-up is about); a callback could not hold it.
    for (const button of row) {
      if (button.data.startsWith("url:")) keyboard.url(button.text, button.data.slice(4));
      else keyboard.text(button.text, button.data);
    }
  });
  return keyboard;
};

/** Sends a message written in markdown as HTML (so its buttons can redraw it), tracked and logged. */
async function send(bot: Bot, chatId: number, markdown: string, rows: Row[] = [], options: { silent?: boolean } = {}): Promise<number> {
  const id = await sendHtml(bot, chatId, markdownToHtml(markdown), { keyboard: rows.length ? keyboardOf(rows) : undefined, silent: options.silent });
  await track(id, "prompt");
  await logMessage("tony", plain(markdownToHtml(markdown)));
  return id;
}

export async function runSmartJobs(bot: Bot, chatId: number, settings: Settings, now: Date): Promise<number> {
  let sent = 0;
  const quiet = inWindow(now, settings.quiet_start, settings.quiet_end, settings.timezone ?? TIMEZONE);
  const sunday = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short" }).format(now) === "Sun";
  const job = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      console.error(`${name} failed:`, error);
      await logEvent("job_failed", { job: name, error: String(error instanceof Error ? error.message : error).slice(0, 300) });
    }
  };

  if (!quiet) {
    // His main priority (22 Nov): chased until it is done, before anything else is said this minute.
    await job("main-priority", async () => {
      const nudge = await mainPriorityNudge(now);
      if (!nudge) return;
      await send(bot, chatId, nudge.text, nudge.rows);
      await logEvent("main_nudge", { task_id: nudge.taskId, n: nudge.step.n, kind: nudge.step.kind });
      sent++;
    });
    // d) Missed today: one message for all of them, later the same day.
    if (sent === 0) {
      await job("follow-up", async () => {
        const followUp = await sameDayFollowUp(now);
        if (!followUp) return;
        await send(bot, chatId, followUp.text, followUp.rows);
        await noteFollowUp(followUp.taskIds, now);
        sent++;
      });
    }
    // b) A rule that fires on its own: days without a workout, and the video he chose for it.
    if (sent === 0) {
      await job("rules", async () => {
        sent += await runRuleChecks(now, async (text: string, item?: LibraryItem) => {
          const id = await send(bot, chatId, text);
          if (item?.source === "media") {
            const media = await loadMedia(item.id);
            if (media) await sendMedia(bot, chatId, media, esc(mediaCaption(media))).catch(() => undefined);
          } else if (item?.url) {
            await send(bot, chatId, `${item.title ?? "The link"}\n${item.url}`);
          }
          return id;
        });
      });
    }
    // c) A free-time suggestion, when he is free.
    if (sent === 0) {
      await job("free-time", async () => {
        if (!(await shouldSuggestFreeTime(now))) return;
        const suggestion = await suggestFreeTime(now);
        if (!suggestion?.taskId) return;
        await send(bot, chatId, suggestion.text, suggestion.rows);
        await countFreeTime(now);
        sent++;
      });
    }
    // d) Sunday evening: the inbox items untouched for a week.
    if (sent === 0 && sunday) {
      await job("inbox-review", async () => {
        if ((await budgetLeft(now)) <= 0 || !(await dueToday("inbox-review", "19:30", now))) return;
        const review = await weeklyInboxReview(now);
        if (!review) return;
        await send(bot, chatId, review.text, review.rows, { silent: true });
        await notify("inbox_review", now);
        sent++;
      });
    }
  }

  // Sunday night: the memory review (what held moves up a layer, what went stale is dropped).
  // It runs even in quiet hours or with the day's budget spent; then only the summary is skipped.
  if (sent === 0 && sunday) {
    await job("memory-review", async () => {
      if (!(await dueToday("memory-review", "21:30", now))) return;
      const review = await weeklyMemoryReview(now);
      if (!review || quiet || (await budgetLeft(now)) <= 0) return;
      await send(bot, chatId, review.text, review.rows, { silent: true });
      await notify("memory_review", now);
      sent++;
    });
  }

  // e) The daily jobs.
  await job("backup", async () => {
    if (await dueToday("backup", "03:00", now)) await runBackup(now);
  });
  await job("budget", async () => {
    if (quiet || !(await dueToday("budget", "09:00", now))) return;
    const warnings = await budgetWarnings(now);
    if (warnings.length) await send(bot, chatId, ["⚠️ **Budget**", ...warnings].join("\n"));
  });
  // A document kept before Tony could read it whole (the IELTS plan, 22 Nov) is read again from its copy: one a minute, each once.
  await job("reread", async () => {
    const db = requireDb();
    const { data } = await db.from("media").select("id, mime, description").eq("kind", "document").not("storage_path", "is", null).order("id", { ascending: false }).limit(30);
    const waiting = ((data ?? []) as { id: number; mime: string | null; description: string | null }[]).filter((row) => readableDocument(row.mime ?? "", row.description?.split("\n")[0]) && needsReading(row.description));
    if (waiting.length === 0) return;
    const tried = await db.from("events").select("detail").eq("kind", "document_reread").limit(200);
    const done = new Set(((tried.data ?? []) as { detail: { id?: number } }[]).map((row) => Number(row.detail?.id)));
    const next = waiting.find((row) => !done.has(row.id));
    if (!next) return;
    await logEvent("document_reread", { id: next.id });
    await rereadDocument(next.id);
  });
  // Once an hour: the burst waiting room is tidied.
  if (now.getMinutes() === 7) await job("prune", () => pruneIncoming(now));
  // Once per deployment: Telegram is told which updates to send (👎 reactions, phase e) and the new commands.
  await job("telegram-setup", async () => {
    const build = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID;
    if (!build) return;
    const { data } = await requireDb().from("events").select("detail").eq("kind", "telegram_setup").order("id", { ascending: false }).limit(1);
    const last = ((data ?? []) as { detail: { build?: string } }[])[0]?.detail?.build;
    if (last === build) return;
    await logEvent("telegram_setup", { build });
    await connectTelegram(bot, settings.app_url, env.telegramWebhookSecret);
  });
  return sent;
}

/** The 07:00 self-test: silent when all is well; ONE message when something is broken. Run after the tick answers. */
export async function runSelfTestJob(bot: Bot, chatId: number, now: Date): Promise<void> {
  try {
    if (!(await dueToday("selftest", "07:00", now))) return;
    const result = await selfTest(now);
    if (!result.ok) await send(bot, chatId, selfTestAlert(result));
  } catch (error) {
    console.error("Self-test failed:", error);
  }
}

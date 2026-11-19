import "server-only";
import { Bot, type Context } from "grammy";
import { respond } from "./brain";
import { env } from "./env";
import { logMessage } from "./messages";
import { inboxMessage, todayMessage } from "./replies";
import { runAction } from "./actions";
import { parseAction } from "./reminder-messages";
import { addScheduledTask } from "./reminders";
import { addInboxTask, listInbox, listToday } from "./tasks";
import { addMinutes, formatTime, toWholeMinute } from "./time";
import { MAX_VOICE_SECONDS, transcribeVoice } from "./voice";

let cached: { token: string; bot: Bot } | undefined;

/** The bot, or undefined while TELEGRAM_BOT_TOKEN is not set. */
export function getBot(): Bot | undefined {
  const token = env.telegramBotToken;
  if (!token) return undefined;
  if (cached?.token === token) return cached.bot;

  const apiRoot = env.telegramApiRoot;
  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);

  // /start is answered for anyone, so the owner can learn their chat ID
  // before TELEGRAM_OWNER_ID is set. It reveals nothing but the sender's own ID.
  bot.command("start", (ctx) => {
    const ownerId = env.telegramOwnerId;
    if (ownerId === undefined) {
      return ctx.reply(
        `Good day, sir. Tony, at your service. Your chat ID is ${ctx.chat.id}; ` +
          "set it as TELEGRAM_OWNER_ID and I shall answer to you alone.",
      );
    }
    if (ctx.chat.id !== ownerId) return;
    return ctx.reply("Good day, sir. Tony, at your service.");
  });

  // Single user: once the owner is known, everyone else is ignored.
  bot.use((ctx, next) => {
    const ownerId = env.telegramOwnerId;
    if (ownerId !== undefined && ctx.chat?.id !== ownerId) return;
    return next();
  });

  bot.command("ping", (ctx) => ctx.reply("pong"));

  // Past this point Tony reads and writes tasks, which only the owner may do.
  bot.use((ctx, next) => {
    if (env.telegramOwnerId !== undefined) return next();
    return ctx.reply("One moment, sir: send /start and set TELEGRAM_OWNER_ID first, so I know whom I serve.");
  });

  // Answer the user and let Telegram have its 200; otherwise Telegram keeps
  // redelivering the same message for as long as the fault lasts.
  const tasks = bot.errorBoundary(async ({ ctx, error }) => {
    console.error("Bot handler failed:", error);
    try {
      await ctx.reply("My apologies, sir. I could not reach the task list just now.");
    } catch (replyError) {
      console.error("Could not send the apology:", replyError);
    }
  });

  tasks.command("inbox", async (ctx) => ctx.reply(inboxMessage(await listInbox())));

  tasks.command("today", async (ctx) => ctx.reply(todayMessage(await listToday())));

  // Test aid for the reminder engine:
  //   /test       persistent task due in 2 minutes, nudging every minute
  //   /test full  the same with the real schedule (15, 30, 60, 90, 120 min)
  //   /test once  an ordinary one-time reminder in 2 minutes
  tasks.command("test", async (ctx) => {
    const mode = ctx.match.trim().toLowerCase();
    const dueAt = toWholeMinute(addMinutes(new Date(), 2));
    const persistent = mode !== "once";
    const task = await addScheduledTask({
      title: persistent ? "Test workout" : "Test reminder",
      dueAt,
      persistent,
      schedule: persistent && mode !== "full" ? [0, 1, 2, 3] : undefined,
    });
    return ctx.reply(
      `Noted, sir. "${task.title}" at ${formatTime(dueAt)}${persistent ? ", persistent mode on" : ""}.`,
    );
  });

  // Button taps: straight to code, no AI model.
  tasks.on("callback_query:data", async (ctx) => {
    const parsed = parseAction(ctx.callbackQuery.data);
    if (!parsed) return ctx.answerCallbackQuery({ text: "I no longer recognise that button, sir." });
    let outcome;
    try {
      outcome = await runAction(parsed.action, parsed.taskId, parsed.arg);
    } finally {
      // Always stop the button's spinner, even when the action failed.
      await ctx.answerCallbackQuery().catch(() => undefined);
    }
    await ctx
      .editMessageReplyMarkup({ reply_markup: outcome.keyboard ?? undefined })
      .catch((error) => console.error("Could not update the buttons:", error));
    if (outcome.text) {
      await ctx.reply(outcome.text);
      await logMessage("tony", outcome.text);
    }
  });

  // One path for typed and spoken messages: the brain, with a safe fallback.
  const think = async (ctx: Context, text: string) => {
    try {
      return await ctx.reply(await respond(text, "telegram"));
    } catch (error) {
      // Capture must never fail: if the model is down, keep his words safe.
      console.error("Brain failed, saving to inbox instead:", error);
      const task = await addInboxTask(text);
      const reply = `My thinking is briefly unavailable, sir, so I saved "${task.title}" to the inbox as it stands.`;
      await logMessage("tony", reply);
      return ctx.reply(reply);
    }
  };

  tasks.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      return ctx.reply("I don't know that command, sir. Try /today or /inbox.");
    }
    if (!text) return;
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    return think(ctx, text);
  });

  // Voice notes (and audio files): transcribe, then treat like typed text.
  tasks.on(["message:voice", "message:audio"], async (ctx) => {
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media) return;
    if (media.duration > MAX_VOICE_SECONDS) {
      return ctx.reply("That one is rather long, sir. Could you give me the short version?");
    }
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    let text: string;
    try {
      text = await transcribeVoice(bot, media.file_id);
    } catch (error) {
      console.error("Voice note failed:", error);
      return ctx.reply("My apologies, sir. I could not hear that one; would you send it again or type it?");
    }
    if (!text) return ctx.reply("I heard only silence, sir. Would you say that again?");
    return think(ctx, text);
  });

  tasks.on("message", (ctx) => ctx.reply("Text or a voice note, sir; I cannot read that kind of message yet."));

  cached = { token, bot };
  return bot;
}

import "server-only";
import { Bot } from "grammy";
import { env } from "./env";
import { inboxMessage, todayMessage } from "./replies";
import { addInboxTask, listInbox, listToday } from "./tasks";

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

  // Any other plain text is a task for the Inbox.
  tasks.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      return ctx.reply("I don't know that command, sir. Try /today or /inbox.");
    }
    if (!text) return;
    const task = await addInboxTask(text);
    return ctx.reply(`Noted, sir. "${task.title}" is in the inbox.`);
  });

  tasks.on("message", (ctx) => ctx.reply("Text only for now, sir. Voice notes come a little later."));

  cached = { token, bot };
  return bot;
}

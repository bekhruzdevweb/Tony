import "server-only";
import { Bot } from "grammy";
import { env } from "./env";

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

  bot.on("message", (ctx) =>
    ctx.reply("I am online, sir, though I cannot take tasks just yet. Try /ping."),
  );

  cached = { token, bot };
  return bot;
}

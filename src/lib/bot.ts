import "server-only";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { think } from "./brain";
import { env } from "./env";
import { logMessage } from "./messages";
import { inboxMessage, todayMessage } from "./replies";
import { runAction } from "./actions";
import { parseAction } from "./reminder-messages";
import { createLoginCode } from "./session";
import { getSettings } from "./settings";
import { addScheduledTask, otherReminderMessages, taskForReminderMessage } from "./reminders";
import { addInboxTask, listInbox, listToday } from "./tasks";
import { addMinutes, formatTime, toWholeMinute } from "./time";
import { connectTelegram, HELP } from "./telegram-setup";
import { MAX_VOICE_SECONDS, speak, transcribeVoice } from "./voice";

let cached: { token: string; bot: Bot } | undefined;

/** Separates a reminder's text from the outcome written into it after a tap. */
const OUTCOME_MARK = "\n\n— ";

/** The bot, or undefined while TELEGRAM_BOT_TOKEN is not set. */
export function getBot(): Bot | undefined {
  const token = env.telegramBotToken;
  if (!token) return undefined;
  if (cached?.token === token) return cached.bot;

  const apiRoot = env.telegramApiRoot;
  // grammY waits up to 500 seconds for Telegram by default, far longer than a
  // serverless function lives. Fail fast instead, so callers can retry.
  const bot = new Bot(token, { client: { timeoutSeconds: 15, ...(apiRoot ? { apiRoot } : {}) } });

  // /start is answered for anyone, so the owner can learn their chat ID
  // before TELEGRAM_OWNER_ID is set. It reveals nothing but the sender's own ID.
  bot.command("start", async (ctx) => {
    const ownerId = env.telegramOwnerId;
    if (ownerId === undefined) {
      return ctx.reply(
        `Good day, sir. Tony, at your service. Your chat ID is ${ctx.chat.id}; ` +
          "set it as TELEGRAM_OWNER_ID and I shall answer to you alone.",
      );
    }
    if (ctx.chat.id !== ownerId) return;
    // Also refreshes the command list and the Menu button, so a new
    // deployment can be connected from Telegram itself.
    const menu = await getSettings()
      .then((settings) => connectTelegram(bot, settings.app_url))
      .catch((error) => (console.error("Could not set the menu:", error), { menuButton: false }));
    return ctx.reply(
      menu.menuButton
        ? "Good day, sir. Tony, at your service. The Menu button beside the message field opens the app."
        : "Good day, sir. Tony, at your service.",
    );
  });

  // Single user: once the owner is known, everyone else is ignored.
  bot.use((ctx, next) => {
    const ownerId = env.telegramOwnerId;
    if (ownerId !== undefined && ctx.chat?.id !== ownerId) return;
    return next();
  });

  bot.command("ping", (ctx) => ctx.reply("pong"));

  bot.command("help", (ctx) => ctx.reply(HELP));

  // The app: opens inside Telegram with one tap, and a one-time key for the
  // home-screen app, which cannot see Telegram's sign-in.
  bot.command("app", async (ctx) => {
    if (env.telegramOwnerId === undefined) return ctx.reply("Set TELEGRAM_OWNER_ID first, sir.");
    try {
      const { code, appUrl } = await createLoginCode();
      const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
      const inTelegram = appUrl?.startsWith("https://");
      return await ctx.reply(
        inTelegram
          ? `Tap below to open the app here, sir. For the home-screen app, the key is ${spaced} (once, within ten minutes).`
          : `Your key to the app, sir: ${spaced}. It works once, for ten minutes.`,
        { reply_markup: inTelegram ? new InlineKeyboard().webApp("Open Tony", appUrl!) : undefined },
      );
    } catch (error) {
      console.error("Login code failed:", error);
      return ctx.reply("My apologies, sir. I could not prepare a key just now.");
    }
  });

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

  // Button taps: straight to code, no AI model. The answer is written into
  // the tapped message itself instead of adding another message to the chat.
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

    const tapped = ctx.callbackQuery.message;
    const original = tapped && "text" in tapped && tapped.text ? tapped.text.split(OUTCOME_MARK)[0] : undefined;
    const reply_markup = outcome.keyboard ?? undefined;
    if (!outcome.text) {
      // Only the buttons change (Reschedule shows its choices).
      await ctx.editMessageReplyMarkup({ reply_markup }).catch((error) => console.error("Could not update the buttons:", error));
      return;
    }

    let edited = false;
    if (original) {
      edited = await ctx.editMessageText(`${original}${OUTCOME_MARK}${outcome.text}`, { reply_markup }).then(
        () => true,
        (error) => (console.error("Could not edit the message:", error), false),
      );
    }
    // A message too old to edit still gets its answer, as a new message.
    if (!edited) await ctx.reply(outcome.text);
    await logMessage("tony", outcome.text);

    // The question is settled, so the buttons on this task's other reminders go too.
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      for (const messageId of await otherReminderMessages(parsed.taskId, tapped?.message_id)) {
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined }).catch(() => undefined);
      }
    }
  });

  // One path for typed and spoken messages: the brain, with a safe fallback.
  // Returns what Tony said, so a voice note can also be answered aloud.
  const answer = async (ctx: Context, text: string): Promise<string> => {
    // Replying to one of Tony's reminders says which task is meant.
    let context: string | undefined;
    const repliedTo = ctx.message?.reply_to_message?.message_id;
    if (repliedTo !== undefined) {
      const task = await taskForReminderMessage(repliedTo).catch(() => undefined);
      if (task) context = `He is replying to your reminder about task #${task.id} "${task.title}". His message is about that task.`;
    }

    try {
      const { reply, tools } = await think(text, { channel: "telegram", context });
      await ctx.reply(reply);
      // A small acknowledgement on his own message when something was written down or ticked off.
      const reaction = tools.includes("complete_task")
        ? "👌"
        : tools.some((tool) => ["add_task", "set_reminder", "remember"].includes(tool))
          ? "✍"
          : undefined;
      if (reaction) await ctx.react(reaction).catch(() => undefined);
      return reply;
    } catch (error) {
      // Capture must never fail: if the model is down, keep his words safe.
      console.error("Brain failed, saving to inbox instead:", error);
      const task = await addInboxTask(text);
      const reply = `My thinking is briefly unavailable, sir, so I saved "${task.title}" to the inbox as it stands.`;
      await logMessage("tony", reply);
      await ctx.reply(reply);
      return reply;
    }
  };

  tasks.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      return ctx.reply("I don't know that command, sir. Try /help.");
    }
    if (!text) return;
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    await answer(ctx, text);
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
    const reply = await answer(ctx, text);

    // Spoken to, Tony answers aloud as well (when a voice is configured).
    try {
      const audio = await speak(reply);
      if (audio) {
        const ogg = audio.type.includes("ogg");
        const file = new InputFile(audio.bytes, ogg ? "tony.ogg" : "tony.wav");
        if (ogg) await ctx.replyWithVoice(file);
        else await ctx.replyWithAudio(file, { title: "Tony", performer: "Tony" });
      }
    } catch (error) {
      console.error("Spoken reply failed:", error);
    }
  });

  tasks.on("message", (ctx) => ctx.reply("Text or a voice note, sir; I cannot read that kind of message yet."));

  cached = { token, bot };
  return bot;
}

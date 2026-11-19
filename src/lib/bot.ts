import "server-only";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { runAction } from "./actions";
import { think } from "./brain";
import { runEvening } from "./briefs";
import {
  CONFIRMATION_HOURS,
  editHtml,
  hoursFromNow,
  protect,
  retire,
  sendTracked,
  setFate,
  track,
  VOICE_REPLY_HOURS,
  type MessageKind,
} from "./chat-log";
import { requireDb } from "./db";
import { env } from "./env";
import { b, code, emphasise, plain } from "./html";
import { logMessage } from "./messages";
import { wavToOggOpus } from "./ogg-opus";
import { handlePollAnswer } from "./polls";
import { finishTask } from "./recurrence";
import { parseAction } from "./reminder-messages";
import { addScheduledTask, otherReminderMessages, scheduleReminder, taskForReminderMessage } from "./reminders";
import { createLoginCode } from "./session";
import { getSettings } from "./settings";
import { addInboxTask, OPEN_STATUSES, type Task } from "./tasks";
import { connectTelegram, HELP } from "./telegram-setup";
import { addMinutes, formatTime, toWholeMinute } from "./time";
import { dayFromKey, dayView, inboxView } from "./views";
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
      .then((settings) => connectTelegram(bot, settings.app_url, env.telegramWebhookSecret))
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
    // A poll vote names the voter but no chat; in a private chat the two ids are the same.
    const who = ctx.chat?.id ?? ctx.from?.id ?? ctx.pollAnswer?.user?.id;
    if (ownerId !== undefined && who !== ownerId) return;
    return next();
  });

  bot.command("ping", (ctx) => ctx.reply("pong"));

  bot.command("help", (ctx) => ctx.reply(HELP));

  /** Sends formatted text to the chat of this update, recording it when it has a kind. */
  const say = (ctx: Context, html: string, options: Parameters<typeof sendTracked>[3] = {}) => sendTracked(bot, ctx.chat!.id, html, options);

  /** A command he typed and its reply replace the previous pair of the same kind. */
  const freshCommand = async (ctx: Context, kind: MessageKind) => {
    await retire({ kinds: [kind] });
    if (ctx.msg) await track(ctx.msg.message_id, kind, { incoming: true });
  };

  // The app: opens inside Telegram with one tap, and a one-time key for the
  // home-screen app, which cannot see Telegram's sign-in.
  bot.command("app", async (ctx) => {
    if (env.telegramOwnerId === undefined) return ctx.reply("Set TELEGRAM_OWNER_ID first, sir.");
    try {
      const { code: key, appUrl } = await createLoginCode();
      const spaced = code(`${key.slice(0, 3)} ${key.slice(3)}`);
      const inTelegram = appUrl?.startsWith("https://");
      await freshCommand(ctx, "cmd:app");
      await say(
        ctx,
        inTelegram
          ? `Tap below to open the app here, sir.\nFor the home-screen app, the key is ${spaced} (once, within ten minutes).`
          : `Your key to the app, sir: ${spaced}. It works once, for ten minutes.`,
        { keyboard: inTelegram ? new InlineKeyboard().webApp("Open Tony", appUrl!) : undefined, kind: "cmd:app" },
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
      if (ctx.chat) await ctx.reply("My apologies, sir. I could not reach the task list just now.");
    } catch (replyError) {
      console.error("Could not send the apology:", replyError);
    }
  });

  tasks.command("inbox", async (ctx) => {
    await freshCommand(ctx, "cmd:inbox");
    const view = await inboxView();
    await say(ctx, view.html, { kind: "cmd:inbox" });
  });

  // The day as a checklist: each task is a button that ticks it off in place.
  tasks.command("today", async (ctx) => {
    await freshCommand(ctx, "cmd:today");
    const view = await dayView(new Date());
    await say(ctx, view.html, { keyboard: view.keyboard, kind: "cmd:today" });
  });

  tasks.command("tomorrow", async (ctx) => {
    await retire({ kinds: ["plan"] });
    if (ctx.msg) await track(ctx.msg.message_id, "plan", { incoming: true });
    const now = new Date();
    const view = await dayView(addMinutes(now, 24 * 60), now);
    await say(ctx, view.html, { keyboard: view.keyboard, kind: "plan" });
  });

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
    await say(ctx, `Noted, sir. ${b(task.title)} at ${b(formatTime(dueAt))}${persistent ? ", persistent mode on" : ""}.`, {
      kind: "confirmation",
      taskId: task.id,
      deleteAfter: hoursFromNow(CONFIRMATION_HOURS),
    });
  });

  // A vote in one of Tony's polls. Plain code, like the buttons.
  tasks.on("poll_answer", async (ctx) => {
    const ownerId = env.telegramOwnerId;
    if (ownerId === undefined) return;
    await handlePollAnswer(bot, ownerId, ctx.pollAnswer.poll_id, ctx.pollAnswer.option_ids);
  });

  // He pinned a message: it is never tidied away.
  tasks.on("message:pinned_message", (ctx) => protect(ctx.message.pinned_message.message_id));

  // Button taps: straight to code, no AI model. The answer is written into
  // the tapped message itself instead of adding another message to the chat.
  tasks.on("callback_query:data", async (ctx) => {
    const payload = ctx.callbackQuery.data;
    const tapped = ctx.callbackQuery.message;
    const chatId = ctx.chat?.id;
    const tappedText = tapped && "text" in tapped && tapped.text ? tapped.text : undefined;
    // What the message said before any outcome was written into it, safe to send back as HTML.
    const base = tappedText === undefined ? undefined : emphasise(tappedText.split(OUTCOME_MARK)[0]);

    // A checklist box ("ck:<day>:<task>"): tick the task off, or untick it, and redraw the list.
    if (payload.startsWith("ck:")) {
      const [, key, id] = payload.split(":");
      let toast = "That task is gone, sir.";
      try {
        const found = await requireDb().from("tasks").select().eq("id", Number(id)).maybeSingle();
        if (found.error) throw new Error(found.error.message);
        const task = found.data as Task | null;
        if (task && OPEN_STATUSES.includes(task.status)) {
          const { nextLabel } = await finishTask(task, "done");
          toast = nextLabel ? `Done. Next one ${nextLabel}.` : "Done, sir.";
        } else if (task && task.status === "done") {
          const reopened = await requireDb()
            .from("tasks")
            .update({ status: task.due_at ? "todo" : "inbox", completed_at: null })
            .eq("id", task.id);
          if (reopened.error) throw new Error(reopened.error.message);
          if (task.due_at && new Date(task.due_at).getTime() > Date.now()) await scheduleReminder(task.id, new Date(task.due_at));
          toast = "Back on the list, sir.";
        }
      } finally {
        await ctx.answerCallbackQuery({ text: toast }).catch(() => undefined);
      }
      if (chatId === undefined || !tapped) return;
      // Keep what made this message more than a bare list: its greeting and its Open app button.
      const lead = tappedText?.startsWith("Good morning") ? "Good morning, sir." : tappedText?.match(/^Very good, sir\.[^\n]*/)?.[0];
      const view = await dayView(dayFromKey(key), new Date(), { lead });
      const appButton = (tapped.reply_markup?.inline_keyboard ?? []).flat().find((button) => "web_app" in button);
      if (appButton && "web_app" in appButton && appButton.web_app) view.keyboard.webApp(appButton.text, appButton.web_app.url);
      await editHtml(bot, chatId, tapped.message_id, view.html, view.keyboard);
      return;
    }

    // The evening review's own buttons ("ev:...").
    if (payload.startsWith("ev:")) {
      const [, action, id] = payload.split(":");
      let evening: Awaited<ReturnType<typeof runEvening>> | undefined;
      try {
        evening = await runEvening(action, id === undefined ? undefined : Number(id));
      } finally {
        // Stops the button's spinner; a per-task choice is confirmed in the little pop-up.
        await ctx.answerCallbackQuery(evening?.toast ? { text: evening.toast } : undefined).catch(() => undefined);
      }
      if (evening.text) {
        const edited = base !== undefined && chatId !== undefined && tapped ? await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}${evening.text}`, evening.keyboard ?? undefined) : false;
        if (!edited) await say(ctx, evening.text);
        await logMessage("tony", plain(evening.text));
      } else {
        await ctx.editMessageReplyMarkup({ reply_markup: evening.keyboard ?? undefined }).catch(() => undefined);
      }
      return;
    }

    const parsed = parseAction(payload);
    if (!parsed) return ctx.answerCallbackQuery({ text: "I no longer recognise that button, sir." });
    let outcome;
    try {
      outcome = await runAction(parsed.action, parsed.taskId, parsed.arg);
    } finally {
      // Always stop the button's spinner, even when the action failed.
      await ctx.answerCallbackQuery().catch(() => undefined);
    }

    const keyboard = outcome.keyboard ?? undefined;
    if (!outcome.text) {
      // Only the buttons change (Reschedule shows its choices).
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch((error) => console.error("Could not update the buttons:", error));
      return;
    }

    const edited = base !== undefined && chatId !== undefined && tapped ? await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}${outcome.text}`, keyboard) : false;
    // A message too old to edit still gets its answer, as a new message.
    if (!edited) await say(ctx, outcome.text, { kind: "confirmation", taskId: parsed.taskId, deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
    await logMessage("tony", plain(outcome.text));

    if (tapped) {
      // Settling the task marked all its messages for removal. The one just
      // tapped now carries the answer: after Start it waits for Done and
      // stays; otherwise it is a confirmation and goes in a few hours.
      await setFate(
        tapped.message_id,
        parsed.action === "start" ? { kind: "reminder", deleteAfter: null } : { kind: "confirmation", deleteAfter: hoursFromNow(CONFIRMATION_HOURS) },
      );
    }
    // Until the tick removes them, this task's other reminders at least lose their buttons.
    if (chatId !== undefined) {
      for (const messageId of await otherReminderMessages(parsed.taskId, tapped?.message_id)) {
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined }).catch(() => undefined);
      }
    }
  });

  const MUTATING = ["add_task", "update_task", "complete_task", "set_reminder", "remember", "forget"];

  // One path for typed and spoken messages: the brain, with a safe fallback.
  // Returns what Tony said and whether it was a confirmation of something done.
  const answer = async (ctx: Context, text: string, options: { note?: string; keepHours?: number } = {}): Promise<{ reply: string; confirmed: boolean }> => {
    // Replying to one of Tony's messages says which task is meant, and keeps that message.
    let context = options.note;
    const repliedTo = ctx.message?.reply_to_message?.message_id;
    if (repliedTo !== undefined) {
      await protect(repliedTo);
      const task = await taskForReminderMessage(repliedTo).catch(() => undefined);
      if (task) {
        const about = `He is replying to your reminder about task #${task.id} "${task.title}". His message is about that task.`;
        context = context ? `${context} ${about}` : about;
      }
    }

    // "typing…" lasts about five seconds in Telegram; renew it for as long
    // as Tony is thinking, which includes waiting out a rate limit.
    const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => undefined), 4500);
    try {
      const { reply, tools, titles } = await think(text, { channel: "telegram", context }).finally(() => clearInterval(typing));
      const confirmed = tools.some((tool) => MUTATING.includes(tool));
      // A confirmation shows the task and time in bold and is tidied away later; conversation stays.
      await say(
        ctx,
        emphasise(reply, confirmed ? titles : []),
        confirmed ? { kind: "confirmation", deleteAfter: hoursFromNow(options.keepHours ?? CONFIRMATION_HOURS) } : {},
      );
      // A small acknowledgement on his own message when something was written down or ticked off.
      const reaction = tools.includes("complete_task")
        ? "👌"
        : tools.some((tool) => ["add_task", "set_reminder", "remember"].includes(tool))
          ? "✍"
          : undefined;
      if (reaction) await ctx.react(reaction).catch(() => undefined);
      return { reply, confirmed };
    } catch (error) {
      // Capture must never fail: if the model is down, keep his words safe.
      console.error("Brain failed, saving to inbox instead:", error);
      const task = await addInboxTask(text);
      const reply = `My thinking is briefly unavailable, sir, so I saved "${task.title}" to the inbox as it stands.`;
      await logMessage("tony", reply);
      await say(ctx, `My thinking is briefly unavailable, sir, so I saved ${b(task.title)} to the inbox as it stands.`);
      return { reply, confirmed: false };
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
    // Replies to a voice note are kept for a day before any tidying.
    const { reply, confirmed } = await answer(ctx, text, {
      note: "He said this in a voice note; this is its transcript, so you did hear him.",
      keepHours: VOICE_REPLY_HOURS,
    });

    // Spoken to, Tony answers aloud as well (when a voice is configured).
    try {
      const audio = await speak(reply);
      if (audio) {
        let voice: Uint8Array | undefined = audio.type.includes("ogg") ? audio.bytes : undefined;
        if (!voice) {
          // Telegram shows a voice bubble only for OGG/Opus; the speech service sends WAV.
          try {
            voice = wavToOggOpus(audio.bytes);
          } catch (error) {
            console.error("Could not convert the spoken reply to a voice note:", error);
          }
        }
        // Better a music-player message than no voice at all.
        const sent = voice
          ? await ctx.replyWithVoice(new InputFile(voice, "tony.ogg"))
          : await ctx.replyWithAudio(new InputFile(audio.bytes, "tony.wav"), { title: "Tony", performer: "Tony" });
        if (confirmed) await track(sent.message_id, "voice", { deleteAfter: hoursFromNow(VOICE_REPLY_HOURS) });
      }
    } catch (error) {
      console.error("Spoken reply failed:", error);
    }
  });

  tasks.on("message", (ctx) => ctx.reply("Text or a voice note, sir; I cannot read that kind of message yet."));

  cached = { token, bot };
  return bot;
}

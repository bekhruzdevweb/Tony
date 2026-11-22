import "server-only";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { Message, MessageOrigin, Update } from "grammy/types";
import { askForSlot, keyboardOf, runAction } from "./actions";
import { answerFreeTime, freeTimeList } from "./free-time";
import { laterToday } from "./followups";
import { itemLabel } from "./library-rules";
import { libraryView, loadItem, saveToLibrary } from "./library";
import { loggedText, markSent, saveMistake } from "./mistakes";
import { deleteRule, rulesView } from "./rules";
import { latestBackup } from "./safety";
import { describeUrl } from "./library-rules";
import { linksIn, ownWords } from "./brain/reliability";
import { runEvening } from "./briefs";
import {
  CONFIRMATION_HOURS,
  deleteNow,
  DONE_CONFIRMATION_MINUTES,
  editHtml,
  ERROR_MINUTES,
  hoursFromNow,
  minutesFromNow,
  protect,
  retire,
  runCleanup,
  sendTracked,
  setFate,
  SETTLED_MINUTES,
  track,
  trackedKind,
  VOICE_REPLY_HOURS,
  type MessageKind,
} from "./chat-log";
import { requireDb } from "./db";
import { refuseRepeats } from "./dedupe";
import { logEvent } from "./events";
import { env } from "./env";
import { b, code, emphasise, plain } from "./html";
import { askedToSend, asksForMedia, pointsAtMedia, loadMedia, mediaCaption, mediaLabel, mediaListForTask, saveMedia, sendMedia, sendTogether, type Media, sendTaskExample } from "./media";
import { logMessage } from "./messages";
import { handlePollAnswer } from "./polls";
import { finishTask } from "./recurrence";
import { applyPlan, buildPlan, dismissPlan, loadPlan, notePlanMessage, planView, removePlanItem, shiftPlanItem } from "./planner";
import { parseAction } from "./reminder-messages";
import { addScheduledTask, otherReminderMessages, scheduleReminder, taskForReminderMessage, taskForTrackedMessage } from "./reminders";
import { createLoginCode } from "./session";
import { getSettings, setPendingSlot, updateSettings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";
import { boldTimes, editRich, markdownToHtml, sendMarkdown, sendRich, spokenFromMarkdown } from "./rich";
import { cleanFromCommand } from "./sweep";
import { claimsSent, givesTime } from "./brain/checks";
import { CLEANED, handleMessage, type Thought } from "./brain/handle";
import { choicesFor, getRoutine } from "./routine";
import { routineLines } from "./routine-rules";
import { placeTask, runProposal, splitTask } from "./slots";
import { awaitsAnswer, dayLabel, slotButtons, slotQuestion } from "./slot-text";
import { fullNote, soonestSlot } from "./smart-inbox";
import { isCapture as wantsSomething, withoutSendClaims } from "./brain/reliability";
import { HistoryOff, recentChanges, undoChange } from "./history";
import { forgetFact, memoryList } from "./memory";
import { keepDropped } from "./memory-review";
import { memoryPage } from "./memory-rules";
import { dayFromText } from "./schedule";
import { closestCommand, connectTelegram, HELP, knownCommand, TODAY_ALIASES } from "./telegram-setup";
import { addMinutes, formatTime, hisTomorrow, localDate, parseLocalDateTime, TIMEZONE, toWholeMinute } from "./time";
import { BoardNotReady, postBoard, shortLabel, toggleFromBoard } from "./today-board";
import { flipTick, hasTaskList, LIST_TICK, withoutTicks, withTicks } from "./list-ticks";
import { habitsView } from "./habit-view";
import { habitFor, isHabit, streakLine } from "./habits";
import { useOffer } from "./offers";
import { allDone, progress, setSubtaskDone } from "./subtasks";
import { fetchTitle, pageTitle } from "./links";
import { wordsAround } from "./link-rules";
import { rescheduleOverdue } from "./reschedule";
import { locationStatus, prayerStatus, setCoordinates, setLocation, setPrayer, setPrayerCalculation } from "./prayer";
import { dayFromKey, dayView, inboxView } from "./views";
import { readDocument, readableDocument, readImage } from "./vision";

/** How much of a document he sends goes into the message itself. */
const DOCUMENT_IN_MESSAGE = 15_000;
import { asksForVoice, DAILY_VOICE_LIMIT, sayAloud, setVoiceMode, voiceState } from "./speech";
import { downloadTelegramFile, inventedSpeech, MAX_VOICE_SECONDS, transcribeAudio } from "./voice";

let cached: { token: string; bot: Bot } | undefined;

/** Separates a reminder's text from the outcome written into it after a tap. */
const OUTCOME_MARK = "\n\n— ";

/** The bot, with the burst handler the webhook calls for messages sent together (phase b). */
export type TonyBot = Bot & { burst?: (updates: Update[]) => Promise<void> };

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
  // The same text is never sent twice running.
  refuseRepeats(bot);

  // His commands (/today, /help, ...) are removed as soon as Tony has handled
  // them: the answer is what matters. A mistyped command stays ten minutes
  // beside its "did you mean" (see the text handler below).
  bot.use(async (ctx, next) => {
    await next();
    const ownerId = env.telegramOwnerId;
    const message = ctx.message;
    if (!message || !ctx.chat || ownerId === undefined || ctx.chat.id !== ownerId) return;
    if (!knownCommand(message.text)) return;
    await deleteNow(bot, ctx.chat.id, message.message_id);
  });

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

  /** Sends formatted text to the chat of this update, recording it when it has a kind. */
  const say = (ctx: Context, html: string, options: Parameters<typeof sendTracked>[3] = {}) => sendTracked(bot, ctx.chat!.id, html, options);

  /**
   * An apology or "unknown command": removed after ten minutes, together
   * with his message that caused it (unless that was a voice note, which is kept).
   */
  const oops = async (ctx: Context, text: string, options: { keepTheirs?: boolean } = {}) => {
    const deleteAfter = new Date(Date.now() + ERROR_MINUTES * 60_000);
    const sent = await ctx.reply(text);
    await track(sent.message_id, "error", { deleteAfter });
    if (ctx.message && !options.keepTheirs) await track(ctx.message.message_id, "error", { incoming: true, deleteAfter });
  };

  bot.command("ping", async (ctx) => {
    const sent = await ctx.reply("pong");
    await track(sent.message_id, "cmd:ping", { deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
  });

  // One help message at a time.
  bot.command("help", async (ctx) => {
    await retire({ kinds: ["cmd:help"] });
    const sent = await ctx.reply(HELP);
    await track(sent.message_id, "cmd:help");
  });

  /** A command he typed and its reply replace the previous pair of the same kind. */
  const freshCommand = async (_ctx: Context, kind: MessageKind) => {
    await retire({ kinds: [kind] });
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
      return oops(ctx, "My apologies, sir. I could not prepare a key just now.");
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
      if (ctx.chat) await oops(ctx, "My apologies, sir. I could not reach the task list just now.", { keepTheirs: Boolean(ctx.message?.voice) });
    } catch (replyError) {
      console.error("Could not send the apology:", replyError);
    }
  });

  // /clean: sweeps the recent chat in plain code. His command is the newest message, and goes with the rest.
  tasks.command("clean", async (ctx) => {
    await cleanFromCommand(bot, ctx.chat.id, ctx.msg.message_id);
  });

  // /prayer on|off|hanafi|standard|method <n>: prayer times. Plain code, no AI.
  tasks.command("prayer", async (ctx) => {
    const [word, value] = ctx.match.trim().toLowerCase().split(/\s+/);
    try {
      if (word === "on" || word === "off") await setPrayer(word === "on");
      else if (word === "hanafi" || word === "standard" || word === "shafii" || word === "shafi") await setPrayerCalculation({ school: word === "hanafi" ? 1 : 0 });
      else if (word === "method" && /^\d{1,2}$/.test(value ?? "")) await setPrayerCalculation({ method: Number(value) });
      else if (word) return oops(ctx, "Use /prayer on, /prayer off, /prayer hanafi, /prayer standard or /prayer method 3, sir.");
    } catch (error) {
      console.error("Prayer setting failed:", error);
      return oops(ctx, "My apologies, sir. I could not fetch the prayer times just now; I shall try again shortly.");
    }
    const status = await prayerStatus();
    if (!status) return oops(ctx, "Prayer times need a database update first, sir.");
    const times = status.today.map((p) => `${p.status === "done" ? "✓ " : ""}${p.title} ${formatTime(new Date(p.at))}${p.approx ? " (approx.)" : ""}`).join(" · ");
    const text = status.on
      ? `🕌 Prayer times are on for ${status.location} (official times from namoz-vaqti.uz; if the site is down, approximate times, ${status.school === 1 ? "Hanafi" : "standard"} Asr).\n${times || "Today's times will come at 00:05."}\nA quiet note 10 minutes before and one at the time; no voice. /location to change the place.`
      : "🕌 Prayer times are off. /prayer on to turn them on.";
    await retire({ kinds: ["cmd:voice"] });
    const sent = await ctx.reply(text);
    await track(sent.message_id, "cmd:voice", { deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
  });

  // /location <region> or /location <lat> <lng>: where prayer times are for. Plain code, no AI.
  tasks.command("location", async (ctx) => {
    const input = ctx.match.trim();
    const coords = /^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/.exec(input);
    let text: string;
    try {
      if (coords) {
        await setCoordinates(Number(coords[1]), Number(coords[2]));
        text = `Noted, sir: ${coords[1]}, ${coords[2]} for the approximate times, if the official site is ever down.`;
      } else if (input) {
        await ctx.replyWithChatAction("typing").catch(() => undefined);
        const name = await setLocation(input);
        const status = await prayerStatus();
        const times = (status?.today ?? []).map((p) => `${p.title} ${formatTime(new Date(p.at))}`).join(" · ");
        text = `📍 ${name}. Prayer times now follow the official table for it.${times ? `\nToday: ${times}` : ""}`;
      } else {
        const where = await locationStatus();
        if (!where) return oops(ctx, "Locations need a database update first, sir.");
        text = `📍 ${where.name} (${where.slug}; fallback coordinates ${where.lat}, ${where.lng}).\nTo change it: /location Xiva shahri, or /location 41.47 60.78 for the coordinates.`;
      }
    } catch (error) {
      console.error("Location failed:", error);
      return oops(ctx, `I could not find "${input}" on namoz-vaqti.uz, sir. Try the region as the site writes it, for example "Xonqa tumani" or "Urganch shahri".`);
    }
    await retire({ kinds: ["cmd:voice"] });
    const sent = await ctx.reply(text);
    await track(sent.message_id, "cmd:voice", { deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
  });

  // /voice on|off|auto: when Tony speaks. Plain code, no AI.
  tasks.command("voice", async (ctx) => {
    const wanted = ctx.match.trim().toLowerCase();
    if (wanted === "on" || wanted === "off" || wanted === "auto") await setVoiceMode(wanted);
    else if (wanted) return oops(ctx, "Use /voice on, /voice off or /voice auto, sir.");
    const state = await voiceState();
    const what = {
      auto: `I speak for the morning brief, nudges that matter and a reminder's final call, at most ${DAILY_VOICE_LIMIT} a day (${Math.min(state.count, DAILY_VOICE_LIMIT)} used today), and whenever you ask. Replies to your voice notes are text.`,
      on: "I speak for the morning brief, nudges, final calls and replies to your voice notes, with no daily limit.",
      off: "I speak only when you ask (\"say it\", \"tell me\").",
    }[state.mode];
    await retire({ kinds: ["cmd:voice"] });
    const sent = await ctx.reply(`Voice: ${state.mode}. ${what}`);
    await track(sent.message_id, "cmd:voice", { deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
  });

  // /undo: the last ten changes to his tasks, each with ↩. Plain code.
  tasks.command("undo", async (ctx) => {
    await showUndo(ctx.chat.id);
  });

  // /habits (Phase H): each habit's week and run, a ✓ for each still to do today, and the plans' progress. Plain code.
  tasks.command("habits", async (ctx) => {
    await retire({ kinds: ["cmd:habits"] });
    const view = await habitsView(new Date());
    const sent = await sendRich(bot, ctx.chat.id, view.html, { keyboard: view.keyboard });
    await track(sent, "cmd:habits", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
  });

  // /memory: what Tony keeps about him, each with 🗑. Plain code.
  tasks.command("memory", async (ctx) => {
    await retire({ kinds: ["cmd:memory"] });
    const view = await memoryView();
    const sent = await sendMarkdown(bot, ctx.chat.id, view.text, { keyboard: view.keyboard });
    await track(sent, "cmd:memory", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
  });

  // /routine: his routine as Tony uses it. Plain code. He changes it by telling Tony ("I teach Mon–Fri 14–18").
  // "Show my rules": each with 🗑 (phase b).
  tasks.command("rules", async (ctx) => {
    const view = await rulesView();
    await sendMarkdown(bot, ctx.chat.id, view.text, { keyboard: view.rows.length ? keyboardOf(view.rows) : undefined });
  });

  // His library: everything he saved, each sent back with a tap.
  tasks.command("library", async (ctx) => {
    const view = await libraryView();
    await sendMarkdown(bot, ctx.chat.id, view.text, { keyboard: view.rows.length ? keyboardOf(view.rows) : undefined });
  });

  // The 🌙 Free Time list (phase c).
  tasks.command("freetime", async (ctx) => {
    const list = await freeTimeList();
    await sendMarkdown(bot, ctx.chat.id, list.text, { keyboard: list.rows.length ? keyboardOf(list.rows) : undefined });
  });

  // Today's backup of tasks, memory and the library, as a file (phase e).
  tasks.command("backup", async (ctx) => {
    const backup = await latestBackup();
    if (!backup) return ctx.reply("No backup yet, sir: the first is made at 03:00.");
    await ctx.replyWithDocument(new InputFile(Buffer.from(backup.json, "utf8"), `tony-backup-${backup.day}.json`), { caption: `Backup of ${backup.day}: tasks, memory and library.` });
  });

  tasks.command("routine", async (ctx) => {
    const routine = await getRoutine();
    await retire({ kinds: ["cmd:routine"] });
    const lines = routineLines(routine).map((line) => {
      const [name, ...rest] = line.split(": ");
      return `- **${name}**: ${rest.join(": ")}`;
    });
    const text = [
      "**Your routine, sir**, as I use it for every time I choose:",
      ...lines,
      "",
      "_Tell me to change any of it: \"I teach Mon–Fri 14:00–18:00\", \"content 10–12\", \"Sunday is my free day\". When you move a task, I learn the time you prefer for that kind of task._",
    ].join("\n");
    const sent = await sendMarkdown(bot, ctx.chat.id, text);
    await track(sent, "cmd:routine", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
  });

  tasks.command("inbox", async (ctx) => {
    await freshCommand(ctx, "cmd:inbox");
    const view = await inboxView();
    await say(ctx, view.html, { kind: "cmd:inbox" });
  });

  // The pinned Today message (also /checklist and /list). Sends a new one,
  // pins it, and removes the one before, so there is only ever one.
  tasks.command(["today", ...TODAY_ALIASES], async (ctx) => {
    try {
      await postBoard(bot, ctx.chat.id);
    } catch (error) {
      if (!(error instanceof BoardNotReady)) throw error;
      // Until the database update is applied, /today answers as it did before: the day as a checklist.
      const view = await dayView(new Date());
      await say(ctx, view.html, { keyboard: view.keyboard, kind: "cmd:today" });
    }
  });

  // "/plan" or "/plan week": Tony proposes times for what is overdue or in the inbox.
  tasks.command("plan", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const result = await buildPlan({ scope: ctx.match.trim().toLowerCase().startsWith("week") ? "week" : "day" });
    if ("nothing" in result) return ctx.reply(`${result.nothing.replace(/\.$/, "")}, sir.`);
    await showPlan(ctx.chat.id, result.plan.id);
  });

  tasks.command("tomorrow", async (ctx) => {
    await retire({ kinds: ["plan"] });
    const now = new Date();
    // After midnight, "tomorrow" is the day just begun (the day after he sleeps).
    const view = await dayView(hisTomorrow(now), now);
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
    const isCaption = Boolean(tapped && !("text" in tapped && tapped.text) && "caption" in tapped && tapped.caption);
    const tappedText = tapped && "text" in tapped && tapped.text ? tapped.text : tapped && "caption" in tapped && tapped.caption ? tapped.caption : undefined;
    // What the message said before any outcome was written into it, safe to send back as HTML.
    const base = tappedText === undefined ? undefined : emphasise(tappedText.split(OUTCOME_MARK)[0]);

    // The pinned Today message ("td:<task>" or "td:add"). The message itself
    // is redrawn after every update, so the handler only has to make the change.
    if (payload.startsWith("td:")) {
      const what = payload.slice(3);
      if (what === "add") {
        await ctx.answerCallbackQuery().catch(() => undefined);
        await updateSettings({ pending_note: "He tapped Add on the Today list. His next message is a task to add; if he gives no day, it is for today.", pending_note_at: new Date().toISOString() });
        await say(ctx, "What shall I add, sir?", { kind: "confirmation", deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
        return;
      }
      let toast = "My apologies, sir. That did not go through.";
      try {
        toast = await toggleFromBoard(Number(what));
      } finally {
        await ctx.answerCallbackQuery({ text: toast }).catch(() => undefined);
      }
      return;
    }

    // "✓ Done" / "↩ Undo" on a line of a list reply ("lt:<task>"): the same tick as on the board, in plain code,
    // and that line is redrawn ticked or unticked.
    if (payload.startsWith(LIST_TICK)) {
      const taskId = Number(payload.slice(LIST_TICK.length));
      let toast = "My apologies, sir. That did not go through.";
      try {
        toast = await toggleFromBoard(taskId);
      } finally {
        await ctx.answerCallbackQuery({ text: toast }).catch(() => undefined);
      }
      await logEvent("task_tap", { task_id: taskId, action: toast.startsWith("Back") ? "undo" : "done" });
      if (chatId !== undefined && tapped) await redrawList(chatId, tapped.message_id, taskId, tapped.reply_markup ? InlineKeyboard.from(tapped.reply_markup.inline_keyboard) : undefined);
      return;
    }

    // ✓ on /habits ("hb:<task>"): today's check-in, in plain code; the list is redrawn with the new run.
    if (payload.startsWith("hb:")) {
      const taskId = Number(payload.slice(3));
      let toast = "That habit is gone, sir.";
      try {
        const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
        const habit = found.data as Task | null;
        if (habit && OPEN_STATUSES.includes(habit.status) && isHabit(habit)) {
          const before = await habitFor(habit.id);
          if (before?.doneToday) toast = "Already done today, sir.";
          else {
            await finishTask(habit, "done");
            const after = await habitFor(habit.id);
            toast = after ? `Done, sir. ${streakLine(after)}.` : "Done, sir.";
            await logEvent("task_tap", { task_id: habit.id, action: "done" });
          }
        }
      } finally {
        await ctx.answerCallbackQuery({ text: toast.slice(0, 190) }).catch(() => undefined);
      }
      if (chatId !== undefined && tapped) {
        const view = await habitsView(new Date());
        await editRich(bot, chatId, tapped.message_id, view.html, view.keyboard);
      }
      return;
    }

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
      if (tapped && Date.now() - tapped.date * 1000 > 15 * 60 * 60_000) {
        await ctx.answerCallbackQuery({ text: "That review was for an earlier evening, sir. Send /today for what is open now." }).catch(() => undefined);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        return;
      }
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

    // A plan's buttons ("pl:..."): apply it, adjust it, or make a new one.
    if (payload.startsWith("pl:")) {
      const [, action, a, b2, c] = payload.split(":");
      let toast: string | undefined;
      try {
        if (action === "new") {
          const now = new Date();
          const result = await buildPlan({ scope: "day", day: a === "tomorrow" ? hisTomorrow(now) : now, now });
          if ("nothing" in result) toast = result.nothing;
          else if (chatId !== undefined) await showPlan(chatId, result.plan.id);
          return;
        }
        const planId = Number(a);
        let plan = await loadPlan(planId);
        let mode: "view" | "adjust" = "adjust";
        if (!plan) {
          toast = "That plan is gone, sir.";
          return;
        }
        if (action === "ap" && plan.day.slice(0, 10) < localDate(new Date())) {
          toast = "That plan was for a day that has passed, sir. Send /plan for a new one.";
          mode = "view";
        } else if (action === "ap") {
          const done = await applyPlan(planId);
          plan = done.plan;
          mode = "view";
          toast = done.applied ? `Applied: ${done.applied} ${done.applied === 1 ? "task" : "tasks"} scheduled.` : "Nothing was left to apply, sir.";
        } else if (action === "m") {
          const moved = await shiftPlanItem(planId, Number(b2), Number(c));
          plan = moved.plan ?? plan;
          toast = moved.note;
        } else if (action === "x") {
          plan = (await removePlanItem(planId, Number(b2))) ?? plan;
        } else if (action === "no") {
          plan = (await dismissPlan(planId)) ?? plan;
          mode = "view";
        } else if (action === "re") {
          await dismissPlan(planId);
          const again = await buildPlan({
            scope: plan.scope,
            day: new Date(`${plan.day.slice(0, 10)}T12:00:00+05:00`),
            instructions: "Propose different times from before.",
            // A proposal for tasks he just gave stays about those tasks.
            ...(plan.compact ? { taskIds: [...plan.items.map((item) => item.task_id), ...plan.left_out.map((item) => item.task_id)] } : {}),
          });
          if ("nothing" in again) toast = again.nothing;
          else plan = again.plan;
          mode = "view";
        } else if (action === "tomall") {
          // Every overdue task to tomorrow, at its own time of day. Plain code.
          const moved = await rescheduleOverdue("tomorrow");
          toast = moved ? `Moved ${moved} to tomorrow, sir.` : "Nothing overdue, sir.";
          mode = "view";
        } else if (action === "noop") {
          return;
        }
        if (plan && chatId !== undefined && tapped) {
          const view = await planView(plan, new Date(), plan.status === "proposed" ? mode : "view");
          await editRich(bot, chatId, tapped.message_id, view.html, view.keyboard);
          if (plan.message_id === null || action === "re") await notePlanMessage(plan.id, tapped.message_id);
        }
      } finally {
        await ctx.answerCallbackQuery(toast ? { text: toast.slice(0, 190) } : undefined).catch(() => undefined);
      }
      return;
    }

    // An answer to a question Tony asked with buttons ("ch:<n>"), or "Other".
    // A part of a task, ticked from the board. Plain code. Ticking the last part asks about the task.
    if (payload.startsWith("st:")) {
      const id = Number(payload.slice(3));
      const result = await setSubtaskDone(id, true).catch((error) => (console.error("Subtask tick failed:", error), undefined));
      if (!result) {
        await ctx.answerCallbackQuery({ text: "That part is gone, sir." }).catch(() => undefined);
        return;
      }
      const part = result.subtasks.find((s) => s.id === id);
      await ctx.answerCallbackQuery({ text: `✓ ${part?.title ?? "Done"} (${progress(result.subtasks)})`.slice(0, 190) }).catch(() => undefined);
      if (allDone(result.subtasks) && chatId !== undefined) {
        const parent = (await requireDb().from("tasks").select("title, status").eq("id", result.taskId).maybeSingle()).data as { title: string; status: string } | null;
        if (parent && OPEN_STATUSES.includes(parent.status as Task["status"])) {
          await sendMarkdown(bot, chatId, `Every part of **${parent.title}** is done, sir. Mark the task itself done?`, { keyboard: completeKeyboard(result.taskId) });
        }
      }
      return;
    }

    // "Not yet" after "mark the task done?": nothing changes; the buttons go.
    if (payload === "keep") {
      await ctx.answerCallbackQuery({ text: "Very good, sir." }).catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return;
    }

    // Under the Sunday memory review: ↩ puts back what it dropped (once), 🧠 opens /memory. Plain code.
    if (payload.startsWith("mr:")) {
      if (payload === "mr:view") {
        await ctx.answerCallbackQuery().catch(() => undefined);
        if (chatId === undefined) return;
        await retire({ kinds: ["cmd:memory"] });
        const view = await memoryView();
        const sent = await sendMarkdown(bot, chatId, view.text, { keyboard: view.keyboard });
        await track(sent, "cmd:memory", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
        return;
      }
      const outcome = await keepDropped(Number(payload.split(":")[2]), new Date());
      await ctx.answerCallbackQuery({ text: outcome.slice(0, 190) }).catch(() => undefined);
      await logMessage("tony", outcome);
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("🧠 See memory", "mr:view") }).catch(() => undefined);
      return;
    }

    // ↩ on /undo ("un:<change>") and 🗑 on /memory ("mem:<note>"): done in plain code, the list redrawn with the outcome on top.
    if (payload.startsWith("un:") || payload.startsWith("mem:")) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      const undo = payload.startsWith("un:");
      const id = Number(payload.slice(undo ? 3 : 4));
      const outcome = undo ? await undoChange(id) : await forgetFact(id);
      await logMessage("tony", outcome);
      const view = undo ? await undoView(outcome) : await memoryView(outcome);
      const edited = chatId !== undefined && tapped ? await editRich(bot, chatId, tapped.message_id, markdownToHtml(boldTimes(view.text)), view.keyboard) : false;
      if (!edited && chatId !== undefined) await sendMarkdown(bot, chatId, view.text, { keyboard: view.keyboard });
      return;
    }

    // Tony's slot for a day he named ("sl:..."): ✓ takes it, a time he picks is his, ✏️ shows the free ones. Plain code.
    if (payload.startsWith("sl:")) {
      const [, action, id, value] = payload.split(":");
      const taskId = Number(id);
      // The button's spinner always stops: with the outcome as a note on the screen when there is one.
      let answered = false;
      const answer = async (note?: string) => {
        if (answered) return;
        answered = true;
        await ctx.answerCallbackQuery(note ? { text: note.slice(0, 190) } : undefined).catch(() => undefined);
      };
      // [✏️ Other time] answers with a small note on the screen, not a message.
      if (action === "other") await answer("Type the time");
      else if (action !== "ok" && action !== "at" && action !== "split") await answer();
      // The question stays in the chat until he answers it (the day he named lives only in its buttons;
      // 21 Nov 20:25: "…23 November" was asked, never answered, and removed with the receipts at 23:26).
      // Answered, the outcome is a note on the screen and the question goes at once (22 Nov 16:05: "why
      // still on chat"); a new question in its place stays.
      const showOutcome = async (text: string, keyboard?: InlineKeyboard, fate: "answered" | "waiting" = "answered") => {
        // His tap turns the question into its receipt ("✓ Brush my teeth → today, 12:00"), which stays as his
        // record (23 Nov 04:52: the question vanished on his tap, "Why he's deleting his own messages?").
        await answer();
        const edited = chatId !== undefined && tapped ? await editRich(bot, chatId, tapped.message_id, markdownToHtml(boldTimes(text)), keyboard) : false;
        if (!edited && chatId !== undefined) {
          const sent = await sendMarkdown(bot, chatId, boldTimes(text), { keyboard });
          await track(sent, fate === "waiting" ? "prompt" : "confirmation", { taskId, deleteAfter: fate === "waiting" ? undefined : hoursFromNow(CONFIRMATION_HOURS) });
        }
        if (edited && tapped) await setFate(tapped.message_id, { kind: fate === "waiting" ? "prompt" : "confirmation", deleteAfter: fate === "waiting" ? null : hoursFromNow(CONFIRMATION_HOURS) });
        await logMessage("tony", text);
      };
      if (action === "ok" || action === "at") {
        try {
          // An old question's slot never undoes a time he set since (he typed one, or tapped another question).
          const current = (await requireDb().from("tasks").select("title, due_at, updated_at, status").eq("id", taskId).maybeSingle()).data as Pick<Task, "title" | "due_at" | "updated_at" | "status"> | null;
          const chosen = new Date(Number(value) * 60_000);
          if (current?.due_at && tapped && current.status !== "draft" && new Date(current.due_at).getTime() !== chosen.getTime() && new Date(current.updated_at).getTime() > tapped.date * 1000 + 60_000) {
            const when = new Date(current.due_at);
            await showOutcome(`**${current.title}** is already set for ${when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TIMEZONE })}, **${formatTime(when)}**. Tell me if you want it changed.`);
            return;
          }
          // A slot he tapped is his choice: placed, and it teaches Tony when he likes this kind of task.
          const result = await placeTask(taskId, chosen, { learn: true });
          await showOutcome(result.text);
        } finally {
          await answer();
        }
        return;
      }
      if (action === "split") {
        try {
          // [✂️ Split …]: the two halves, only on his tap.
          const [, , , first, second] = payload.split(":");
          const result = await splitTask(taskId, [new Date(Number(first) * 60_000), new Date(Number(second) * 60_000)]);
          await showOutcome(result.text);
        } finally {
          await answer();
        }
        return;
      }
      if (action === "keep") {
        // [📥 Inbox] under the smart inbox's suggestion: it stays unplanned, and the question goes.
        const found = await requireDb().from("tasks").select("title").eq("id", taskId).maybeSingle();
        const title = (found.data as { title?: string } | null)?.title ?? "It";
        return showOutcome(`📥 **${title}** stays in the inbox.`);
      }
      if (action === "later") {
        // [📅 Later day]: the next day after this one that has room, in the same message.
        const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
        const task = found.data as Task | null;
        if (!task) return showOutcome("That task no longer exists, sir.");
        const suggestion = await soonestSlot(task, new Date(), { after: value });
        if (!suggestion) return showOutcome(`**${task.title}**: the next two weeks are full, sir. It stays in the inbox.`);
        const text = slotQuestion({ title: task.title, marks: "", when: dayLabel(suggestion.day, new Date()).when, options: suggestion.options, note: fullNote(suggestion.full, new Date()) || undefined });
        await showOutcome(text, keyboardOf(slotButtons({ kind: "ask", taskId, day: suggestion.day, options: suggestion.options, inbox: true })), "waiting");
        return;
      }
      if (action === "edit") {
        // [✏️ Change] under Tony's own pick: the free times that day, best first, and Other.
        const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
        const task = found.data as Task | null;
        if (!task) return showOutcome("That task no longer exists, sir.");
        const options = (await choicesFor({ ...task, due_at: null } as Task, parseLocalDateTime(`${value}T12:00`)!, new Date())).filter((option) => !task.due_at || option.at.getTime() !== new Date(task.due_at).getTime());
        if (options.length === 0) return showOutcome(`**${task.title}**: nothing else is free that day, sir.`, keyboardOf([[{ text: "✏️ Other time", data: `sl:other:${taskId}:${value}` }]]));
        const text = slotQuestion({ title: task.title, marks: "", when: dayLabel(value, new Date()).when, options });
        await showOutcome(text, keyboardOf(slotButtons({ kind: "ask", taskId, day: value, options })), "waiting");
        return;
      }
      if (action === "other") {
        // No new message: the question shows it is waiting, and the next time he types is placed in code.
        const found = await requireDb().from("tasks").select("title").eq("id", taskId).maybeSingle();
        const title = (found.data as { title?: string } | null)?.title ?? "the task";
        await setPendingSlot({ task_id: taskId, day: value });
        await updateSettings({ pending_note: `He is choosing a time for task #${taskId} "${title}" on ${value}. His next message gives it: set it with update_task.`, pending_note_at: new Date().toISOString() });
        const waiting = `✏️ **${title}** ${dayLabel(value, new Date()).when.replace(/,$/, "")}: type the time.`;
        const edited = chatId !== undefined && tapped ? await editRich(bot, chatId, tapped.message_id, markdownToHtml(waiting)) : false;
        if (!edited) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        return;
      }
      return;
    }

    // Tony's proposal ("pa:..."): ✓ carries it out in plain code; ✏️ lets him say otherwise.
    if (payload.startsWith("pa:")) {
      const [, action, id] = payload.split(":");
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (action === "ok") {
        const text = await runProposal(Number(id));
        const edited = chatId !== undefined && tapped ? await editRich(bot, chatId, tapped.message_id, markdownToHtml(boldTimes(text))) : false;
        if (!edited && chatId !== undefined) await sendMarkdown(bot, chatId, boldTimes(text));
        await logMessage("tony", text);
        return;
      }
      if (action === "edit") {
        const found = await requireDb().from("offers").select("payload").eq("id", Number(id)).maybeSingle();
        const said = (found.data as { payload?: { say?: string } } | null)?.payload?.say ?? "your proposal";
        await requireDb().from("offers").update({ used_at: new Date().toISOString(), used_as: "changed" }).eq("id", Number(id));
        await updateSettings({ pending_note: `He tapped Change on your proposal: "${said}". His next message says what he wants instead.`, pending_note_at: new Date().toISOString() });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        await say(ctx, "What should I do instead, sir?", { kind: "confirmation", deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
        return;
      }
      return;
    }

    // [🧭 Find a time] under new inbox tasks (older messages): free slots on the day he named. Plain code.
    const slot = /^slot:(\d{4}-\d{2}-\d{2}):([\d,]+)$/.exec(payload);
    if (slot) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      const day = parseLocalDateTime(`${slot[1]}T12:00`)!;
      const result = await buildPlan({ scope: "day", day, now: new Date(), taskIds: slot[2].split(",").map(Number) });
      if ("plan" in result && ctx.chat) await showPlan(ctx.chat.id, result.plan.id);
      else await say(ctx, "No free time that day, sir; they stay in the inbox.", { kind: "error", deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
      return;
    }

    // "Keep both" under a clash warning: nothing changes; the buttons go.
    if (payload === "clash:keep") {
      await ctx.answerCallbackQuery({ text: "Both stay, sir." }).catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return;
    }

    // Offers: a task suggested in conversation, or a summarised link. Plain code, no AI.
    if (payload.startsWith("of:")) {
      const [, how, idText] = payload.split(":");
      const outcome = await useOffer(how, Number(idText));
      await ctx.answerCallbackQuery({ text: outcome.toast }).catch(() => undefined);
      if (!outcome.used) return;
      // The tapped button goes; any others on the message stay.
      const rows = (tapped?.reply_markup?.inline_keyboard ?? [])
        .map((row) => row.filter((button) => !("callback_data" in button) || button.callback_data !== payload))
        .filter((row) => row.length > 0);
      await ctx.editMessageReplyMarkup({ reply_markup: rows.length ? { inline_keyboard: rows } : undefined }).catch(() => undefined);
      return;
    }

    // The follow-up ladder's buttons ("fu:<action>:<task>"): plain code, never the model (phase d).
    // "📅 All to tomorrow" under a long follow-up: each listed task still open moves to tomorrow. Plain code.
    if (payload.startsWith("fu:all:")) {
      const ids = payload.slice("fu:all:".length).split(",").map(Number).filter(Boolean);
      const { data } = await requireDb().from("tasks").select("id, status").in("id", ids);
      let moved = 0;
      for (const row of (data ?? []) as { id: number; status: Task["status"] }[]) {
        if (!OPEN_STATUSES.includes(row.status)) continue;
        await runAction("tomorrow", row.id, undefined);
        moved++;
      }
      const line = moved ? `📅 ${moved} moved to tomorrow, sir.` : "Already settled, sir.";
      await ctx.answerCallbackQuery({ text: line }).catch(() => undefined);
      if (chatId !== undefined && tapped && base !== undefined) await editHtml(bot, chatId, tapped.message_id, `${base}\n${line}`, undefined, isCaption);
      else await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      // Every task in it is handled: the follow-up goes now; the note on the screen said what happened (a brief keeps its place).
      if (chatId !== undefined && tapped && (await trackedKind(tapped.message_id)) === "prompt") await deleteNow(bot, chatId, tapped.message_id);
      await logMessage("tony", line);
      return;
    }
    if (payload.startsWith("fu:")) {
      const [, action, id] = payload.split(":");
      const taskId = Number(id);
      const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
      const task = found.data as Task | null;
      let line: string | undefined;
      let toast = "Done, sir.";
      try {
        // A move from an older message never undoes a move he made since: "already moved" instead.
        const sentAt = (tapped?.date ?? 0) * 1000;
        const movedSince = task && task.due_at && new Date(task.due_at).getTime() > Date.now() && new Date(task.updated_at).getTime() > sentAt;
        if (!task || !OPEN_STATUSES.includes(task.status)) {
          toast = "Already settled, sir.";
        } else if (movedSince && (action === "later" || action === "tom" || action === "snooze")) {
          const when = new Date(task.due_at!);
          line = `↪️ ${b(task.title)} is already moved to ${when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TIMEZONE })}, ${formatTime(when)}.`;
          toast = plain(line).slice(0, 180);
        } else if (action === "done" || action === "drop" || action === "tom") {
          const outcome = await runAction(action === "tom" ? "tomorrow" : action, taskId, undefined);
          // An undated task's "tomorrow" is a question with its slots: it comes as its own message, kept until he answers it.
          if (outcome.keyboard && outcome.text) await say(ctx, outcome.text, { keyboard: outcome.keyboard, kind: outcome.waiting ? "prompt" : "confirmation", taskId, deleteAfter: outcome.waiting ? undefined : hoursFromNow(CONFIRMATION_HOURS) });
          else line = outcome.text;
          toast = plain(outcome.text ?? "Done").slice(0, 180);
        } else if (action === "snooze") {
          const outcome = await runAction("snooze", taskId, 15);
          line = outcome.text;
          toast = plain(outcome.text ?? "Snoozed").slice(0, 180);
        } else if (action === "later") {
          const at = await laterToday(task, new Date());
          const outcome = await runAction("move", taskId, Math.round(at.getTime() / 60_000));
          line = outcome.text;
          toast = plain(outcome.text ?? "Moved").slice(0, 180);
        } else if (action === "steps") {
          await setPendingSlot({ task_id: taskId, steps: true });
          line = `🧩 Type the steps for ${b(task.title)}, one per line.`;
          toast = "Type the steps";
        } else if (action === "slot" || action === "sched") {
          const outcome = await askForSlot(task, hisTomorrow(new Date()), new Date());
          if (outcome.text) await say(ctx, outcome.text, { keyboard: outcome.keyboard ?? undefined, kind: outcome.waiting ? "prompt" : "confirmation", taskId, deleteAfter: outcome.waiting ? undefined : hoursFromNow(CONFIRMATION_HOURS) });
          toast = "Pick a time";
        } else if (action === "keep") {
          await requireDb().from("tasks").update({ updated_at: new Date().toISOString() }).eq("id", taskId);
          line = `📌 ${b(task.title)} stays in the inbox.`;
          toast = "Kept";
        }
      } finally {
        await ctx.answerCallbackQuery({ text: toast }).catch(() => undefined);
      }
      // The tapped task's buttons go; the others stay; what happened is written under the list.
      const rows = (tapped?.reply_markup?.inline_keyboard ?? []).map((row) => row.filter((button) => !("callback_data" in button) || !String(button.callback_data).endsWith(`:${taskId}`))).filter((row) => row.length > 0);
      if (chatId !== undefined && tapped && base !== undefined) await editHtml(bot, chatId, tapped.message_id, line ? `${base}\n${line}` : base, rows.length ? InlineKeyboard.from(rows) : undefined, isCaption);
      else await ctx.editMessageReplyMarkup({ reply_markup: rows.length ? InlineKeyboard.from(rows) : undefined }).catch(() => undefined);
      // No task left to answer in it ("📅 All to tomorrow" alone is not one): the follow-up goes now (the note
      // on the screen said what happened), unless it is waiting for steps or a time he will type. A brief stays.
      const left = rows.flat().some((button) => "callback_data" in button && /^fu:(?!all:)/.test(String(button.callback_data)));
      if (chatId !== undefined && tapped && !left && action !== "steps" && action !== "slot" && action !== "sched" && (await trackedKind(tapped.message_id)) === "prompt") {
        await deleteNow(bot, chatId, tapped.message_id);
      }
      if (line) await logMessage("tony", plain(line));
      return;
    }

    // A free-time suggestion ("ft:now|later|list:<task>"): plain code (phase c).
    if (payload.startsWith("ft:")) {
      const [, action, id] = payload.split(":");
      await ctx.answerCallbackQuery().catch(() => undefined);
      const result = action === "list" ? await freeTimeList() : await answerFreeTime(action, Number(id));
      if (action === "list") {
        if (chatId !== undefined) await sendMarkdown(bot, chatId, result.text, { keyboard: result.rows?.length ? keyboardOf(result.rows) : undefined });
      } else if (chatId !== undefined && tapped && base !== undefined) {
        await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}${markdownToHtml(result.text)}`, undefined, isCaption);
      }
      // Starting it now: the example he kept with it (a post he forwarded) comes too.
      if (action === "now" && chatId !== undefined) {
        const sent = await sendTaskExample(bot, chatId, Number(id)).catch((error) => (console.error("Could not send the task's example:", error), false as const));
        // It goes from the chat with the task's other messages once the task is done or moved.
        if (sent) for (const messageId of sent) await track(messageId, "reminder", { taskId: Number(id) });
      }
      await logMessage("tony", result.text);
      return;
    }

    // 🗑 on a rule ("ru:del:<rule>"): removed on his tap, the list redrawn (phase b).
    if (payload.startsWith("ru:del:")) {
      const ruleId = Number(payload.split(":")[2]);
      const removed = await deleteRule(ruleId);
      await ctx.answerCallbackQuery({ text: removed ? "Rule removed" : "That rule is already gone" }).catch(() => undefined);
      const view = await rulesView();
      const text = `${removed ? "🗑 Rule removed." : "That rule is already gone."}\n\n${view.text}`;
      const edited = chatId !== undefined && tapped ? await editRich(bot, chatId, tapped.message_id, markdownToHtml(text), view.rows.length ? keyboardOf(view.rows) : undefined) : false;
      if (!edited && chatId !== undefined) await sendMarkdown(bot, chatId, text, { keyboard: view.rows.length ? keyboardOf(view.rows) : undefined });
      await logMessage("tony", text);
      return;
    }

    // A library item he picked from two that fit ("lib:send:<source>:<id>"): sent at once, in code (phase b).
    if (payload.startsWith("lib:send:")) {
      const [, , source, id] = payload.split(":");
      await ctx.answerCallbackQuery().catch(() => undefined);
      // On the /library list the buttons stay (he may want another); on a "which one?" question they go.
      const isList = Boolean(tapped && "text" in tapped && tapped.text?.startsWith("📚"));
      if (!isList) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      if (chatId !== undefined) await sendLibraryItem(chatId, `${source}:${id}`);
      return;
    }

    if (payload.startsWith("ch:")) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      const { pending_choices: pending } = await getSettings();
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      if (!pending) return;
      const pick = payload.slice(3);
      if (pick === "other") {
        // No extra "tell me in your own words" message: the question itself shows it waits for his words.
        await updateSettings({ pending_note: `You asked him: "${pending.question}". He chose to answer in his own words; his next message is that answer.`, pending_note_at: new Date().toISOString() });
        if (chatId !== undefined && tapped) await editRich(bot, chatId, tapped.message_id, markdownToHtml(boldTimes(`${pending.question}\n✏️ _Type your answer._`)));
        return;
      }
      const chosen = pending.options[Number(pick)];
      if (!chosen) return;
      if (base !== undefined && chatId !== undefined && tapped) await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}${emphasise(chosen)}`);
      await answer(ctx, chosen, { note: `He tapped this as his answer to your question: "${pending.question}". Act on it; do not ask again.` });
      return;
    }

    // "Other…" on a suggestion: he will say when, in words.
    if (payload.startsWith("oth:") || payload.startsWith("sg:no:")) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      const taskId = Number(payload.split(":").pop());
      if (tapped) await setFate(tapped.message_id, { kind: "confirmation", deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
      if (payload.startsWith("sg:no:")) return;
      const found = await requireDb().from("tasks").select().eq("id", taskId).maybeSingle();
      const task = found.data as Task | null;
      if (!task) return;
      await updateSettings({ pending_note: `You asked him when he would do task #${task.id} "${task.title}". His next message is probably the answer: set that time with update_task.`, pending_note_at: new Date().toISOString() });
      // The time he types next is placed in code; no extra message, the suggestion shows it is waiting.
      await setPendingSlot({ task_id: task.id, day: localDate(new Date()) });
      if (base !== undefined && chatId !== undefined && tapped) await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}✏️ Type the time.`);
      return;
    }

    const parsed = parseAction(payload);
    if (!parsed) return ctx.answerCallbackQuery({ text: "I no longer recognise that button, sir." });
    // A one-tap move on an older reminder never undoes a move he made since (as on the follow-ups).
    if (["snooze", "tomorrow", "today", "weekend"].includes(parsed.action) && tapped) {
      const current = (await requireDb().from("tasks").select("title, due_at, updated_at, status").eq("id", parsed.taskId).maybeSingle()).data as Pick<Task, "title" | "due_at" | "updated_at" | "status"> | null;
      if (current && OPEN_STATUSES.includes(current.status) && current.due_at && new Date(current.due_at).getTime() > Date.now() && new Date(current.updated_at).getTime() > tapped.date * 1000 + 60_000) {
        const when = new Date(current.due_at);
        const text = `↪️ ${b(current.title)} is already moved to ${when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TIMEZONE })}, ${formatTime(when)}.`;
        await ctx.answerCallbackQuery({ text: plain(text).slice(0, 180) }).catch(() => undefined);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        return;
      }
    }
    let outcome: Awaited<ReturnType<typeof runAction>> | undefined;
    try {
      outcome = await runAction(parsed.action, parsed.taskId, parsed.arg);
    } finally {
      // Always stop the button's spinner, even when the action failed. A settled task (done, skipped,
      // moved) gets its outcome as a small note on the screen too: the message itself goes in a minute.
      const settledNow = outcome?.text && !outcome.waiting && !outcome.keyboard && parsed.action !== "start";
      await ctx.answerCallbackQuery(settledNow ? { text: plain(outcome!.text!).slice(0, 190) } : undefined).catch(() => undefined);
    }
    // He answered about this task: his main priority's chase counts from here (main-priority.ts).
    await logEvent("task_tap", { task_id: parsed.taskId, action: parsed.action });

    const keyboard = outcome.keyboard ?? undefined;
    if (!outcome.text) {
      // Only the buttons change (Reschedule shows its choices).
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch((error) => console.error("Could not update the buttons:", error));
      return;
    }
    // Done, skipped, dropped or moved: nothing more to ask about this task (22 Nov: "after i reschedule the
    // task it should be deleted from chat or after i complete the task cuz otherwise chat is getting worse").
    // The note on the screen said what happened; the message and the task's other messages go now, not on
    // the next tick (16:05: "why still on chat").
    const settled = !outcome.waiting && !keyboard && parsed.action !== "start";
    if (settled && chatId !== undefined && tapped) {
      await logMessage("tony", plain(outcome.text));
      await deleteNow(bot, chatId, tapped.message_id);
      await runCleanup(bot, chatId).catch((error) => console.error("Could not tidy the task's other messages:", error));
      return;
    }

    const edited = base !== undefined && chatId !== undefined && tapped ? await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}${outcome.text}`, keyboard, isCaption) : false;
    // A message too old to edit still gets its answer: a question as a new message; a settled outcome was the note on the screen.
    if (!edited && !settled) await say(ctx, outcome.text, { keyboard, kind: outcome.waiting ? "prompt" : "confirmation", taskId: parsed.taskId, deleteAfter: outcome.waiting ? undefined : hoursFromNow(CONFIRMATION_HOURS) });
    await logMessage("tony", plain(outcome.text));

    if (tapped) {
      // Settling the task marked all its messages for removal. The one just
      // tapped now carries the answer: after Start it waits for Done and
      // stays; a question about the time still waits for his answer and stays;
      // a message too old to delete is a confirmation and goes in a few hours.
      await setFate(
        tapped.message_id,
        parsed.action === "start"
          ? { kind: "reminder", deleteAfter: null }
          : outcome.waiting && edited
            ? { kind: "prompt", deleteAfter: null }
            : { kind: "confirmation", deleteAfter: settled ? minutesFromNow(SETTLED_MINUTES) : hoursFromNow(CONFIRMATION_HOURS) },
      );
    }
    // Until the tick removes them, this task's other reminders at least lose their buttons.
    if (chatId !== undefined) {
      for (const messageId of await otherReminderMessages(parsed.taskId, tapped?.message_id)) {
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined }).catch(() => undefined);
      }
    }
  });

  /** Sends a proposed plan with [Apply] [Adjust]; it replaces any earlier plan in the chat (not one sent for the same message). */
  const showPlan = async (chatId: number, planId: number, options: { keepEarlier?: boolean } = {}) => {
    const plan = await loadPlan(planId);
    if (!plan) return;
    const view = await planView(plan);
    if (!options.keepEarlier) await retire({ kinds: ["plan"] });
    // A rich message: a heading, the day's times as a list, the reasoning folded away.
    const messageId = await sendRich(bot, chatId, view.html, { keyboard: view.keyboard });
    await track(messageId, "plan");
    await notePlanMessage(plan.id, messageId);
    await logMessage("tony", plain(view.html));
  };

  /** Buttons for what Tony offered: [➕ Make this a task] per offer, and [💾 Save] [➕ Task] for a link. */
  const offerButtons = async (offerIds: number[], link: string | undefined, fetched: { url: string; title: string }[], reply: string): Promise<InlineKeyboard | undefined> => {
    const keyboard = new InlineKeyboard();
    let any = false;
    if (offerIds.length > 0) {
      const titles = offerIds.length > 1 ? ((await requireDb().from("offers").select("id, payload").in("id", offerIds)).data ?? []) : [];
      for (const id of offerIds) {
        const title = (titles as { id: number; payload: { title?: string } }[]).find((row) => Number(row.id) === id)?.payload.title;
        keyboard.text(title ? `➕ ${shortLabel(title, 22)}` : "➕ Make this a task", `of:t:${id}`).row();
        any = true;
      }
    }
    if (link) {
      const page = fetched.find((item) => item.url === link) ?? fetched[0];
      const summary = spokenFromMarkdown(reply).slice(0, 400);
      const { data, error } = await requireDb()
        .from("offers")
        // A real title, not the bare site ("Read: instagram.com"): the page's own, or fetched.
        .insert({ kind: "link", payload: { url: link, title: (page?.title && page.title !== link ? page.title : await fetchTitle(link)).slice(0, 200), summary } })
        .select("id")
        .single();
      if (error) console.error(`Could not keep the link offer: ${error.message}`);
      else {
        const id = (data as { id: number }).id;
        keyboard.text("💾 Save", `of:s:${id}`).text("➕ Task", `of:k:${id}`);
        any = true;
      }
    }
    return any ? keyboard : undefined;
  };

  /** [✓ Mark done] [Not yet] for a task whose parts are all ticked. */
  const completeKeyboard = (taskId: number) => new InlineKeyboard().text("✓ Mark done", `done:${taskId}`).text("Not yet", "keep");

  const MUTATING = ["add_task", "update_task", "complete_task", "set_reminder", "remember", "forget"];

  // One path for typed and spoken messages: his message, request by request, each confirmed on its own.
  // Returns what Tony said and whether something was confirmed done.
  const answer = async (ctx: Context, text: string, options: { note?: string; keepHours?: number; link?: string } = {}): Promise<{ reply: string; confirmed: boolean; completed: boolean }> => {
    let context = options.note;
    const replied = ctx.message?.reply_to_message;
    const repliedTo = replied?.message_id;
    if (repliedTo !== undefined) {
      await protect(repliedTo);
      // A reminder, a coach nudge or a follow-up about one task: his message is about that task.
      const task = (await taskForReminderMessage(repliedTo).catch(() => undefined)) ?? (await taskForTrackedMessage(repliedTo).catch(() => undefined));
      let about: string | undefined;
      if (task) about = `He is replying to your reminder about task #${task.id} "${task.title}". His message is about that task.`;
      else if (replied?.from?.is_bot) {
        // Any other message of Tony's: what it said, so the answer is about that and nothing else
        // (22 Nov 12:28: "okay what things i have to do can u show me?" under the IELTS message got every task).
        const words = ("text" in replied && replied.text) || ("caption" in replied && replied.caption) || (await loggedText(repliedTo));
        if (words) about = `He is replying to your message: "${String(words).replace(/\s+/g, " ").slice(0, 600)}". His message is about that: answer about that only, not his whole list.`;
      } else if (replied) {
        const words = ("text" in replied && replied.text) || ("caption" in replied && replied.caption);
        if (words) about = `He is replying to his own earlier message: "${String(words).replace(/\s+/g, " ").slice(0, 400)}".`;
      }
      if (about) context = context ? `${context} ${about}` : about;
    }

    // "typing…" lasts about five seconds in Telegram; renew it for as long
    // as Tony is thinking, which includes waiting out a rate limit.
    const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => undefined), 4500);
    // A link to sum up, a forwarded post or a tapped answer is one request; typed or spoken words may hold several.
    const split = !options.link && !options.note?.startsWith("He tapped") && !text.startsWith("[");
    const handled = await handleMessage(text, { channel: "telegram", context, split }).finally(() => clearInterval(typing));
    const replies: string[] = [];
    let confirmed = false;
    let completed = false;
    for (const item of handled) {
      if (item.kind === "clean") {
        // "Clean the chat": the same sweep as /clean, in plain code.
        if (ctx.chat && ctx.message) await cleanFromCommand(bot, ctx.chat.id, ctx.message.message_id);
        replies.push(CLEANED);
        continue;
      }
      if (item.kind === "link") {
        // "Send me the video": the link, at once.
        if (ctx.chat) await sendMarkdown(bot, ctx.chat.id, item.reply);
        replies.push(item.reply);
        continue;
      }
      if (item.kind === "send") {
        // "Send me ideas for my reels": the item he filed under those words, at once, in plain code.
        if (ctx.chat) {
          const sent = await sendMarkdown(bot, ctx.chat.id, item.reply);
          await track(sent, "confirmation", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
          for (const ref of item.refs) await sendLibraryItem(ctx.chat.id, ref);
        }
        replies.push(item.reply);
        continue;
      }
      if (item.kind === "media") {
        // "Send me that photo": the originals, at once; only what Telegram delivered is reported.
        replies.push(await sendOriginals(ctx, item.ids));
        continue;
      }
      if (item.kind === "undo") {
        if (ctx.chat) await showUndo(ctx.chat.id);
        replies.push("(the last changes, to undo)");
        continue;
      }
      if (item.kind === "choose") {
        // Two items fit equally: he picks; the tap sends it, in code.
        if (ctx.chat) await sendMarkdown(bot, ctx.chat.id, item.question, { keyboard: keyboardOf(item.options.map((option) => [option])) });
        replies.push(item.question);
        continue;
      }
      if (item.kind === "free" || item.kind === "rules") {
        if (ctx.chat) await sendMarkdown(bot, ctx.chat.id, boldTimes(item.reply), { keyboard: item.rows.length ? keyboardOf(item.rows) : undefined });
        replies.push(item.reply);
        continue;
      }
      if (item.kind === "placed") {
        // The time he typed after [✏️ Other time], placed in plain code.
        if (ctx.chat) {
          const sent = await sendMarkdown(bot, ctx.chat.id, boldTimes(item.reply));
          await track(sent, "confirmation", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
        }
        replies.push(item.reply);
        confirmed = true;
        continue;
      }
      if (item.kind === "failed") {
        // Nothing was saved: his words are never turned into a task on the model's absence.
        const deleteAfter = new Date(Date.now() + ERROR_MINUTES * 60_000);
        await say(ctx, item.reply, { kind: "error", deleteAfter });
        replies.push(item.reply);
        continue;
      }
      const result = await present(ctx, item.text, item.thought, options);
      replies.push(result.reply);
      confirmed ||= result.confirmed;
      completed ||= result.completed;
    }
    return { reply: replies.join("\n\n"), confirmed, completed };
  };

  /** Sends saved originals back; says only what Telegram confirmed it delivered. */
  const sendOriginals = async (ctx: Context, ids: number[]): Promise<string> => {
    const sent: string[] = [];
    for (const id of ids) {
      const item = ctx.chat ? await loadMedia(id) : undefined;
      if (!item || !ctx.chat) continue;
      await sendMedia(bot, ctx.chat.id, item, emphasise(mediaCaption(item))).then(
        () => {
          sent.push(mediaLabel(item));
          return logEvent("sent_item", { ref: `media:${id}`, label: mediaLabel(item) });
        },
        (error) => console.error("Could not resend media:", error),
      );
    }
    if (sent.length === 0) {
      const reply = "I couldn't find that one, sir.";
      await say(ctx, reply, { kind: "error", deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
      await logMessage("tony", reply);
      return reply;
    }
    const reply = `🖼 Sent: ${sent.join("; ")}`.slice(0, 300);
    await logMessage("tony", reply);
    return reply;
  };

  /** /undo: the last ten changes to his tasks, each with ↩ to put it back. Plain code. */
  const undoView = async (lead?: string): Promise<{ text: string; keyboard?: InlineKeyboard }> => {
    let changes;
    try {
      changes = await recentChanges(10);
    } catch (error) {
      // Before the history table exists (migration 0022), /undo says so instead of failing.
      if (error instanceof HistoryOff) return { text: "Undo starts once the database update is in, sir: changes are recorded from then on." };
      throw error;
    }
    if (changes.length === 0) return { text: `${lead ? `${lead}\n\n` : ""}Nothing left to undo, sir.` };
    const keyboard = new InlineKeyboard();
    changes.forEach((change, index) => {
      keyboard.text(`↩ ${index + 1}`, `un:${change.id}`);
      if (index % 5 === 4) keyboard.row();
    });
    const lines = changes.map((change, index) => `${index + 1}. ${formatTime(new Date(change.at))} · ${change.text}`);
    return { text: [...(lead ? [lead, ""] : []), "**Last changes**, newest first. Tap a number to undo it:", ...lines].join("\n"), keyboard };
  };
  /**
   * One library item sent back: the original file, or the link with its title (phase b).
   * What went out is noted ("sent_item"), so "no, not this one" knows what it is about
   * and that item is never sent again (21 Nov 20:21).
   */
  /** A task's name, for the caption of what is kept with it. */
  const taskTitle = async (taskId: number | null) =>
    taskId === null ? undefined : (((await requireDb().from("tasks").select("title").eq("id", taskId).maybeSingle()).data as { title: string } | null)?.title ?? undefined);

  /**
   * What he asked for, after Tony's words: files together (photos and videos in one album), under the
   * name of the task they are kept with when he wrote nothing with them; links and posts one by one.
   * "task:<id>" is everything kept with that task (22 Nov 01:53: "send it as a preview" got the video only).
   */
  const sendLibraryItems = async (chatId: number, refs: string[]) => {
    const files: Media[] = [];
    let title: string | undefined;
    const others: string[] = [];
    for (const ref of refs) {
      const whole = /^task:(\d+)$/.exec(ref);
      if (whole) {
        title ??= await taskTitle(Number(whole[1]));
        for (const file of await mediaListForTask(Number(whole[1]))) if (!files.some((known) => known.id === file.id)) files.push(file);
        continue;
      }
      const item = await loadItem(ref).catch(() => undefined);
      if (item?.source === "media") {
        const media = await loadMedia(item.id);
        if (media && !files.some((known) => known.id === media.id)) files.push(media);
      } else if (item) others.push(ref);
    }
    if (files.length > 0) {
      const owners = [...new Set(files.map((file) => file.task_id))];
      if (!title && owners.length === 1 && files.every((file) => !mediaCaption(file))) title = await taskTitle(owners[0]);
      await sendTogether(bot, chatId, files, title).then(
        (ids) => Promise.all(ids.map((id) => logEvent("sent_item", { ref: `media:${id}`, label: title ?? mediaLabel(files.find((file) => file.id === id)!) }))),
        (error) => console.error("Could not send the files:", error),
      );
    }
    for (const ref of others) await sendLibraryItem(chatId, ref);
  };

  const sendLibraryItem = async (chatId: number, ref: string) => {
    const item = await loadItem(ref).catch(() => undefined);
    if (!item) return;
    if (item.source === "media") {
      await sendLibraryItems(chatId, [ref]);
      return;
    }
    const text = `${itemLabel(item)}${item.url ? `\n${item.url}` : item.description ? `\n${item.description}` : ""}`;
    await sendMarkdown(bot, chatId, text);
    await logMessage("tony", text);
    await logEvent("sent_item", { ref, label: itemLabel(item) });
  };

  const showUndo = async (chatId: number) => {
    await retire({ kinds: ["cmd:undo"] });
    const view = await undoView();
    const sent = await sendMarkdown(bot, chatId, view.text, { keyboard: view.keyboard });
    await track(sent, "cmd:undo", { deleteAfter: hoursFromNow(CONFIRMATION_HOURS) });
  };

  /** /memory: what Tony keeps about him in its three layers (this week, this month, always), each with 🗑 to forget it. Plain code. */
  const memoryView = async (lead?: string): Promise<{ text: string; keyboard?: InlineKeyboard }> => {
    const page = memoryPage(await memoryList(), new Date());
    if (page.ids.length === 0) return { text: `${lead ? `${lead}\n\n` : ""}I keep nothing about you yet, sir.` };
    const keyboard = new InlineKeyboard();
    page.ids.forEach((id, index) => {
      keyboard.text(`🗑 ${index + 1}`, `mem:${id}`);
      if (index % 5 === 4) keyboard.row();
    });
    return {
      text: [
        ...(lead ? [lead, ""] : []),
        "🧠 **What I keep about you**, sir. Tap a number to forget it.",
        ...page.lines,
        ...(page.hidden ? [`_+${page.hidden} older notes not shown_`] : []),
        "",
        "_Every Sunday night, what held moves up a layer and what went stale is dropped._",
      ].join("\n"),
      keyboard,
    };
  };

  /** His open tasks' ids and titles (not prayers), to find which one a list line names. */
  const openTaskTitles = async (): Promise<Pick<Task, "id" | "title">[]> => {
    const { data } = await requireDb().from("tasks").select("id, title, kind").in("status", OPEN_STATUSES).limit(200);
    return ((data ?? []) as { id: number; title: string; kind: string | null }[]).filter((task) => task.kind !== "prayer");
  };

  /** A list reply's line ticked or unticked after "✓ Done" / "↩ Undo" on it, in place. */
  const redrawList = async (chatId: number, messageId: number, taskId: number, markup: InlineKeyboard | undefined) => {
    const { data } = await requireDb().from("events").select("id, detail").eq("kind", "list_reply").order("id", { ascending: false }).limit(40);
    const row = ((data ?? []) as { id: number; detail: { message_id?: number; markdown?: string } | null }[]).find((event) => Number(event.detail?.message_id) === messageId);
    if (!row?.detail?.markdown) return;
    const found = await requireDb().from("tasks").select("status, completed_at").eq("id", taskId).maybeSingle();
    const task = found.data as Pick<Task, "status" | "completed_at"> | null;
    // Done, or a repeating one ticked today (it has rolled on to its next date).
    const done = task ? task.status === "done" || Boolean(task.completed_at && localDate(new Date(task.completed_at)) === localDate(new Date())) : true;
    const markdown = flipTick(row.detail.markdown, taskId, done);
    if (markdown === row.detail.markdown) return;
    await bot.api.editMessageText(chatId, messageId, { markdown }, { reply_markup: markup }).catch((error) => console.error("Could not redraw the list:", error));
    await requireDb().from("events").update({ detail: { ...row.detail, markdown } }).eq("id", row.id);
  };

  /** Shows what the brain did for one request: the reply, its buttons, a plan or a question. */
  const present = async (ctx: Context, text: string, thought: Thought, options: { keepHours?: number; link?: string }): Promise<{ reply: string; confirmed: boolean; completed: boolean }> => {
    {
      const { tools, titles, planId, choices, mediaIds, offerIds, fetched, clash } = thought;
      let reply = thought.reply;
      // Whatever he was asked before has now been answered or overtaken.
      await updateSettings({ pending_note: null, pending_note_at: null, ...(choices ? {} : { pending_choices: null }) }).catch(() => undefined);
      // Originals go back when he asks for them in so many words ("send me the photo"), or when Tony
      // found one and he points at it or asks for it in any words: "there was a picture of…",
      // "okay share iit with me" (21 Nov: found, then "I couldn't find that one").
      // Judged on his own words only: a forwarded post's text ("I will find out…") never asks for anything
      // (21 Nov 18:52: a forwarded post made Tony send back five old photos and videos).
      let mediaSent = 0;
      const said = ownWords(text);
      const found = mediaIds?.length ? mediaIds : undefined;
      const wanted = found !== undefined && (asksForMedia(said) || pointsAtMedia(said) || askedToSend(said) || claimsSent(reply));
      if (ctx.chat && wanted) {
        // Only what Tony found for this request: never a search of every saved file by matching words.
        const items = (await Promise.all(found.map((id) => loadMedia(id)))).filter((item): item is Media => item !== undefined);
        // Counted only once Telegram has confirmed the send, and noted, so "no, not this one" knows what went out.
        await sendTogether(bot, ctx.chat.id, items).then(
          (ids) => {
            mediaSent += ids.length;
            return Promise.all(ids.map((id) => logEvent("sent_item", { ref: `media:${id}`, label: mediaLabel(items.find((item) => item.id === id)!) })));
          },
          (error) => console.error("Could not resend media:", error),
        );
      }
      // "Here it is" is only said if something was really sent: otherwise those words go. Items the brain
      // chose with library send (or a rule sends) go out right after these words, so they count
      // (21 Nov 19:18: "Here it is" became "I couldn't find that one", and then the video arrived).
      const sending = (thought.sendItems ?? []).length > 0;
      // A plan or choices on the screen make "here's your plan" true.
      if (mediaSent === 0 && !sending && planId === undefined && !choices && claimsSent(reply) && !tools.includes("save_link")) {
        reply = withoutSendClaims(reply) || (found ? "I found it, sir, but it would not send. Ask me again in a moment." : "I couldn't find that one, sir.");
      }
      if (planId !== undefined && ctx.chat) {
        // Each day he asked for, earliest first ("the entire plan for tomorrow and today": both days, 22 Nov 19:35).
        const shown = thought.planIds?.length ? thought.planIds : [planId];
        for (const [index, id] of shown.entries()) await showPlan(ctx.chat.id, id, { keepEarlier: index > 0 });
        return { reply, confirmed: false, completed: false };
      }
      if (choices && ctx.chat) {
        // A question with guessable answers arrives as buttons, plus a way to say something else.
        const keyboard = new InlineKeyboard();
        choices.options.forEach((option, index) => keyboard.text(option, `ch:${index}`).row());
        keyboard.text("Other…", "ch:other");
        await updateSettings({ pending_choices: choices });
        await sendMarkdown(bot, ctx.chat.id, boldTimes(choices.question), { keyboard });
        return { reply, confirmed: false, completed: false };
      }
      const confirmed = tools.some((tool) => MUTATING.includes(tool));
      // Offers under the reply, acted on in plain code when tapped: a task suggested in conversation,
      // or a link he sent (now summarised) to save or to turn into a task.
      let keyboard = await offerButtons(offerIds ?? [], options.link, fetched ?? [], reply);
      // Every part ticked: [✓ Mark done] [Not yet], never done without asking.
      if (thought.askComplete) keyboard = completeKeyboard(thought.askComplete.taskId);
      // A day he named without a time: the free slots, best first (⭐), and [✏️ Other time];
      // [✏️ Change] under Tony's own pick; [✂️ Split …] for a long task with no gap for it.
      const slot = thought.slot;
      if (slot) keyboard = keyboardOf(slotButtons(slot));
      // "I'll remove Buy notebook": [✓] does it in plain code, [✏️] lets him say otherwise.
      if (thought.proposal) keyboard = new InlineKeyboard().text("✓ Do it", `pa:ok:${thought.proposal.offerId}`).text("✏️ Change", `pa:edit:${thought.proposal.offerId}`);
      // A clash the change created: move it to the next free hour, or keep both. Plain code.
      if (clash) {
        keyboard ??= new InlineKeyboard();
        if (clash.suggestAt) keyboard.text(`Move ${shortLabel(clash.title, 16)} ${formatTime(clash.suggestAt)}`, `move:${clash.taskId}:${Math.round(clash.suggestAt.getTime() / 60_000)}`);
        keyboard.text("Keep both", "clash:keep");
      }
      // Buttons only for real actions on tasks (Phase 2): a question in conversation is answered in words, never with [Yes] [No].
      // The reply as a rich message (lists, tables, headings), times in bold; a confirmation is tidied away later.
      // A confirmation names its task in bold, as it did before.
      const named = confirmed ? titles.reduce((text, title) => (title && text.includes(title) && !text.includes(`**${title}**`) ? text.replace(title, `**${title}**`) : text), reply) : reply;
      // "Show my rules": each with 🗑 (phase b).
      if (thought.showRules) {
        const view = await rulesView();
        if (view.rows.length) keyboard = keyboardOf(view.rows);
      }
      // He asked for a file or link and nothing went out: the closest few, one tap each (never a second guess, 21 Nov 20:21).
      if (thought.libraryChoices?.length) keyboard = keyboardOf(thought.libraryChoices.map((option) => [option]));
      // A task list: each of his open tasks gets "✓ Done" at the end of its line (a tap on the
      // native box is never reported to Tony, 22 Nov: "why i can't tick the tasks to complete??").
      const shown = boldTimes(named);
      const ticks = hasTaskList(shown) ? withTicks(shown, await openTaskTitles()) : undefined;
      const sent = await sendMarkdown(bot, ctx.chat!.id, ticks?.markdown ?? shown, { keyboard, ...(ticks?.ticked.length ? { fallback: withoutTicks(ticks.markdown) } : {}) });
      if (ticks?.ticked.length) await logEvent("list_reply", { message_id: sent, markdown: ticks.markdown });
      // Which message this reply became, so a 👎 on it finds its words (phase e).
      await markSent(reply, sent);
      // A question about the time for a day he named stays until he answers it (see awaitsAnswer), in his
      // words or with a button; then it goes with the task's other messages. Only done or moved: the receipt
      // goes after ten minutes (22 Nov: "after i complete the task … chat is getting worse").
      if (confirmed) {
        const waits = awaitsAnswer(slot);
        await track(sent, waits ? "prompt" : "confirmation", {
          taskIds: thought.changed,
          deleteAfter: waits ? undefined : thought.settled ? minutesFromNow(DONE_CONFIRMATION_MINUTES) : hoursFromNow(options.keepHours ?? CONFIRMATION_HOURS),
        });
      }
      // What he asked for (or one of his rules sends), after the words: files together, links one by one.
      if (thought.sendItems?.length) await sendLibraryItems(ctx.chat!.id, thought.sendItems);
      // A small acknowledgement on his own message when something was written down or ticked off.
      const reaction = tools.includes("complete_task")
        ? "👌"
        : tools.some((tool) => ["add_task", "set_reminder", "remember"].includes(tool))
          ? "✍"
          : undefined;
      if (reaction) await ctx.react(reaction).catch(() => undefined);
      return { reply, confirmed, completed: tools.includes("complete_task") };
    }
  };

  /** Where a forwarded message came from, in words. */
  const originOf = (origin: MessageOrigin): string => {
    if (origin.type === "channel") return `the channel "${origin.chat.title}"`;
    if (origin.type === "chat") return `the chat "${"title" in origin.sender_chat && origin.sender_chat.title ? origin.sender_chat.title : "unknown"}"`;
    if (origin.type === "user") return [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ");
    return origin.sender_user_name;
  };

  /**
   * A forwarded post, a photo, or other media with a caption. Tony reads
   * the words and the text in the image, tells him what it is and offers to
   * make it a task. It is also remembered as "the last thing he shared", so
   * a following "schedule this for tomorrow" has something to point at.
   */
  const shareItem = async (ctx: Context) => {
    const message = ctx.message;
    if (!message) return;
    // An album arrives as one message per photo; only the captioned one is read.
    if (message.media_group_id && !(message.text ?? message.caption ?? "").trim()) return;
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const read = await readShare(message);
    if (!read) return oops(ctx, "Text, a voice note, a photo, a file or a forwarded post, sir; I cannot read that kind of message yet.");
    // Known before Tony thinks, so "remind me about this tomorrow" in the caption can attach it at once.
    if (read.saved) await updateSettings({ last_shared_media_id: read.saved.id }).catch(() => undefined);
    try {
      await answer(ctx, read.asked);
    } finally {
      if (!read.saved) await updateSettings({ last_shared_media_id: null }).catch(() => undefined);
      await updateSettings({ last_shared_text: read.shared.slice(0, 2000), last_shared_at: new Date().toISOString() }).catch((error) =>
        console.error("Could not remember the shared item:", error),
      );
    }
  };

  /**
   * What a shared item is (a forwarded post, a photo, a file): read, kept
   * (media, or the library for a post), and put into words for the brain. No
   * answer here: shareItem answers one item, a burst answers several together.
   */
  const readShare = async (message: Message): Promise<{ asked: string; shared: string; saved?: Media } | undefined> => {
    const words = (message.text ?? message.caption ?? "").trim();
    // What kind of thing it is, and Telegram's handle on the original.
    const photo = message.photo?.length ? ([...message.photo].reverse().find((size) => (size.file_size ?? 0) <= 3_500_000) ?? message.photo[0]) : undefined;
    const file = photo
      ? { kind: "photo" as const, id: photo.file_id, unique: photo.file_unique_id, mime: "image/jpeg", size: photo.file_size }
      : message.video
        ? { kind: "video" as const, id: message.video.file_id, unique: message.video.file_unique_id, mime: message.video.mime_type ?? "video/mp4", size: message.video.file_size }
        : message.animation
          ? { kind: "animation" as const, id: message.animation.file_id, unique: message.animation.file_unique_id, mime: message.animation.mime_type ?? "video/mp4", size: message.animation.file_size }
          : message.document
            ? { kind: "document" as const, id: message.document.file_id, unique: message.document.file_unique_id, mime: message.document.mime_type ?? "application/octet-stream", size: message.document.file_size }
            : message.video_note
              ? { kind: "video_note" as const, id: message.video_note.file_id, unique: message.video_note.file_unique_id, mime: "video/mp4", size: message.video_note.file_size }
              : undefined;

    let imageText: string | undefined;
    let imageFailed = false;
    // A PDF or text file is read as well (22 Nov 01:59: "can u see my ielts plan?" got "I can't open that document").
    let docText: string | undefined;
    let docFailed = false;
    const docName = message.document?.file_name?.replace(/[[\]«»]/g, "").trim() || undefined;
    let saved: Media | undefined;
    if (file) {
      // A copy goes to private storage when Telegram lets a bot download it (up to 20 MB).
      let bytes: ArrayBuffer | undefined;
      if ((file.size ?? 0) <= 20 * 1024 * 1024) {
        bytes = await downloadTelegramFile(bot, file.id).then(
          (downloaded) => downloaded.bytes,
          (error) => (console.error("Could not download the file:", error), undefined),
        );
      }
      // Images are read: the text in them and what they show.
      if (bytes && file.mime.startsWith("image/")) {
        try {
          imageText = await readImage(bytes, file.mime);
        } catch (error) {
          console.error("Could not read the image:", error);
          imageFailed = true;
        }
      } else if (file.kind === "document" && readableDocument(file.mime, docName)) {
        // Kept with its name first, so the library can name it and "library read" can give its text later.
        try {
          docText = bytes ? await readDocument(bytes, file.mime, docName) : undefined;
          if (!bytes || !docText) docFailed = true;
        } catch (error) {
          console.error("Could not read the document:", error);
          docFailed = true;
        }
      }
      // A video is seen through its cover frame and heard through what is said in it (23 Nov 04:12: "ideas for my
      // stories" could not use the stories video, which Tony had kept without knowing what was in it).
      if (file.kind === "video" || file.kind === "video_note" || file.kind === "animation") {
        imageText = await readVideo(message, bytes).catch((error) => (console.error("Could not read the video:", error), undefined));
      }
      const description = imageText ?? (file.kind === "document" ? [docName, docText].filter(Boolean).join("\n") || undefined : undefined);
      saved = await saveMedia({ kind: file.kind, fileId: file.id, uniqueId: file.unique, mime: file.mime, caption: words, description, bytes }).catch(
        (error) => (console.error("Could not save the media:", error), undefined),
      );
    }
    if (!words && !imageText && !file) return undefined;

    const forwarded = message.forward_origin ? originOf(message.forward_origin) : undefined;
    const thing = file
      ? file.kind === "photo"
        ? "photo"
        : file.kind === "animation"
          ? "GIF"
          : file.kind === "video_note"
            ? "round video"
            : file.kind === "document" && docName
              ? `document "${docName}"`
              : file.kind
      : "post";
    // What was read from it (fenced as material below), or a word on why nothing was.
    // A long document goes to the brain in part (about 4,000 words); library read gives the rest.
    const docPart = docText && docText.length > DOCUMENT_IN_MESSAGE ? `${docText.slice(0, DOCUMENT_IN_MESSAGE)}\n(… the document goes on: library read gives the rest)` : docText;
    const content = imageText && file && file.kind !== "photo" && file.kind !== "document" ? `What is in the ${thing}: ${imageText}` : imageText ? `Text in the image: ${imageText}` : docPart ? `Text in the document${docName ? ` "${docName}"` : ""}:\n${docPart}` : undefined;
    const remark = content
      ? undefined
      : imageFailed
        ? "(Its image could not be read.)"
        : docFailed
          ? "(The document could not be read.)"
          : file && file.kind !== "photo"
            ? `(A ${file.kind === "document" ? "document" : thing}; you cannot see inside it.)`
            : undefined;
    // What Tony keeps as "the last thing he shared".
    const shared = [
      forwarded ? `${file ? `A ${thing}` : "Post"} forwarded from ${forwarded}` : `A ${thing} he sent`,
      forwarded ? words : words ? `He wrote with it: ${words}` : undefined,
      content ?? remark,
      saved ? "(Saved. It can be attached to a task or filed under a label.)" : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    // A forwarded post (with no file) goes into his library; files are kept in media already (phase b).
    if (forwarded && !file && words) await saveToLibrary({ kind: "post", title: `Post from ${forwarded}`, description: words.slice(0, 800), source: "forwarded" });
    for (const url of linksIn(words)) await saveToLibrary({ kind: "link", url, title: await fetchTitle(url, 3_000).catch(() => describeUrl(url)), description: wordsAround(words), source: forwarded ? "forwarded" : "sent" });
    // What the brain is asked: his own caption is his words; what was read from the file (the text in a photo,
    // a PDF) and a forwarded post are material, fenced off as such, so they never count as his words.
    const fenced = content ? `\n«««\n${content}\n»»»` : "";
    const asked = forwarded
      ? `[He forwarded this to you]\n«««\n${shared}\n»»»`
      : words
        ? `${words}\n\n[He attached a ${thing}${remark ? `. ${remark}` : ""}]${fenced}`
        : `[He sent you a ${thing}${remark ? `. ${remark}` : ""}]${fenced}`;
    return { asked, shared, saved };
  };

  /** A video, as words: its cover frame read like a photo, and what is said in it, heard like a voice note. */
  const readVideo = async (message: Message, bytes: ArrayBuffer | undefined): Promise<string | undefined> => {
    const media = message.video ?? message.video_note ?? message.animation;
    if (!media) return undefined;
    const parts: string[] = [];
    const thumb = media.thumbnail;
    if (thumb) {
      const frame = await downloadTelegramFile(bot, thumb.file_id).catch(() => undefined);
      const seen = frame ? await readImage(frame.bytes, "image/jpeg").catch(() => undefined) : undefined;
      if (seen) parts.push(`Cover frame: ${seen}`);
    }
    if (bytes && !message.animation && (media.duration ?? 0) >= 3) {
      const heard = await transcribeAudio(bytes, "video.mp4", "video/mp4").catch(() => undefined);
      if (heard?.trim() && !inventedSpeech(heard)) parts.push(`Said in it: ${heard.trim().slice(0, 1500)}`);
    }
    if (media.duration) parts.push(`Length: ${media.duration} s`);
    return parts.length > (media.duration ? 1 : 0) ? parts.join("\n") : undefined;
  };

  /** A voice note, heard: its words (kept with the original), or why it could not be heard. */
  const hear = async (message: Message): Promise<{ text: string } | { error: string }> => {
    const media = message.voice ?? message.audio;
    if (!media) return { error: "none" };
    if (media.duration > MAX_VOICE_SECONDS) return { error: "long" };
    try {
      const file = await downloadTelegramFile(bot, media.file_id);
      // Telegram names voice notes .oga; transcription services expect .ogg for the same Opus audio.
      const text = await transcribeAudio(file.bytes, file.name.replace(/\.oga$/i, ".ogg"), "audio/ogg");
      // Kept like any other media: the original, a private copy, and what was said.
      await saveMedia({ kind: message.voice ? "voice" : "audio", fileId: media.file_id, uniqueId: media.file_unique_id, mime: media.mime_type ?? "audio/ogg", description: text, bytes: file.bytes }).catch((error) =>
        console.error("Could not save the voice note:", error),
      );
      return { text };
    } catch (error) {
      console.error("Voice note failed:", error);
      return { error: "failed" };
    }
  };

  /**
   * The burst rule (phase b): what he sent within a minute (a photo, a link,
   * a voice note, some words, in any order) is read item by item and
   * answered as ONE request.
   */
  const burst = async (updates: Update[]) => {
    const last = updates[updates.length - 1];
    if (!last.message) return;
    const ctx = new Context(last, bot.api, bot.botInfo);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const parts: string[] = [];
    let shared: string | undefined;
    let savedId: number | undefined;
    let spoken = false;
    for (const update of updates) {
      const message = update.message;
      if (!message) continue;
      if (message.voice || message.audio) {
        const heard = await hear(message);
        if ("text" in heard && heard.text) {
          parts.push(`[In a voice note he said:] ${heard.text}`);
          spoken = true;
        }
        continue;
      }
      if (message.photo || message.video || message.video_note || message.document || message.animation || message.forward_origin || (!message.text && message.caption)) {
        // An album's photos, videos and documents are all read (a post he forwards is all of them; two PDFs he
        // sends together are both his plan: 22 Nov 12:36, the stretching plan sent with the workout plan was dropped).
        if (message.media_group_id && !(message.text ?? message.caption ?? "").trim() && !message.photo && !message.video && !message.document) continue;
        const read = await readShare(message);
        if (read) {
          parts.push(read.asked);
          shared = read.shared;
          if (read.saved) savedId = read.saved.id;
        }
        continue;
      }
      if (message.text) parts.push(message.text.trim());
    }
    if (parts.length === 0) return;
    // Every link in the burst goes into his library with what he wrote around it ("i have to shoot this type of videos").
    const typed = updates.map((update) => update.message?.text ?? "").join("\n");
    for (const url of linksIn(typed)) await saveToLibrary({ kind: "link", url, title: await fetchTitle(url, 3_000).catch(() => describeUrl(url)), description: wordsAround(parts.join("\n")), source: "sent" });
    if (savedId) await updateSettings({ last_shared_media_id: savedId }).catch(() => undefined);
    const { reply } = await answer(ctx, parts.join("\n\n"), {
      note: `He sent these ${updates.length} messages together, within a minute: they are ONE request. Handle them as one, answer once.${spoken ? " One was a voice note; its transcript is included, so you did hear him." : ""}`,
    });
    if (shared) await updateSettings({ last_shared_text: shared.slice(0, 2000), last_shared_at: new Date().toISOString() }).catch(() => undefined);
    void reply;
  };
  (bot as TonyBot).burst = burst;

  tasks.on("message_reaction", async (ctx) => {
    const reaction = ctx.messageReaction;
    if (!reaction) return;
    const added = reaction.new_reaction.some((entry) => entry.type === "emoji" && entry.emoji === "👎");
    if (!added) return;
    const saved = await saveMistake(reaction.message_id).catch(() => false);
    if (saved) await say(ctx, "Noted as a mistake, sir. I'll learn from that one.", { kind: "error", deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
  });

  tasks.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      const guess = closestCommand(text);
      return oops(ctx, guess ? `I don't know that command, sir. Did you mean /${guess}?` : "I don't know that command, sir. /help lists the ones I do.");
    }
    if (!text) return;
    // "👎" (with a note, if he likes) as a reply to one of Tony's messages: a mistake saved (phase e).
    const repliedTo = ctx.message.reply_to_message;
    if (/^👎/.test(text) && repliedTo?.from?.is_bot) {
      const saved = await saveMistake(repliedTo.message_id, text.replace(/^👎\s*/, "") || undefined).catch(() => false);
      return say(ctx, saved ? "Noted as a mistake, sir. I'll learn from that one." : "I could not save that, sir.", { kind: "error", deleteAfter: new Date(Date.now() + ERROR_MINUTES * 60_000) });
    }
    // A forwarded post is material to read, not something he typed.
    if (ctx.message.forward_origin) return shareItem(ctx);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    // A link: Tony reads the page and sums it up; Save and Task buttons come under the summary.
    const found = /https?:\/\/[^\s<>"]+/i.exec(text)?.[0]?.replace(/[).,!?]+$/, "");
    // A link with a request ("remind me to watch this on Monday") is a task: the link goes into its notes.
    const rest = found ? text.replace(found, " ").trim() : "";
    const link = found && !(wantsSomething(rest) || givesTime(rest) || dayFromText(rest, new Date())) ? found : undefined;
    const { reply } = await answer(ctx, text, link ? {
      link,
      note: `He sent a link: ${link}. Read it with web_fetch and sum it up: one line on what it is, then the key points as a short list. If he also asked something about it, answer that. Do not add a task or save anything yourself: Save and Task buttons are shown under your reply.`,
    } : {});
    // Every link he sends goes into his library, with its title (phase b).
    for (const url of linksIn(text)) await saveToLibrary({ kind: "link", url, title: await pageTitle(url).catch(() => describeUrl(url)), description: wordsAround(text), source: "sent" });
    // "Tell me what's left", "say it": he asked to hear it, so the summary is spoken too.
    if (asksForVoice(ownWords(text))) {
      const voiceId = await sayAloud(bot, ctx.chat.id, spokenFromMarkdown(reply), "reply", { asked: true });
      if (voiceId !== undefined) await track(voiceId, "voice", { deleteAfter: hoursFromNow(VOICE_REPLY_HOURS) });
    }
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
      const file = await downloadTelegramFile(bot, media.file_id);
      // Telegram names voice notes .oga; transcription services expect .ogg for the same Opus audio.
      text = await transcribeAudio(file.bytes, file.name.replace(/\.oga$/i, ".ogg"), "audio/ogg");
      // Kept like any other media: the original, a private copy, and what was said.
      await saveMedia({ kind: ctx.message.voice ? "voice" : "audio", fileId: media.file_id, uniqueId: media.file_unique_id, mime: media.mime_type ?? "audio/ogg", description: text, bytes: file.bytes }).catch((error) =>
        console.error("Could not save the voice note:", error),
      );
    } catch (error) {
      console.error("Voice note failed:", error);
      return oops(ctx, "My apologies, sir. I could not hear that one; would you send it again or type it?", { keepTheirs: true });
    }
    if (!text) return ctx.reply("I heard only silence, sir. Would you say that again?");
    // Replies to a voice note are kept for a day before any tidying.
    const { reply, confirmed, completed } = await answer(ctx, text, {
      note: "He said this in a voice note; this is its transcript, so you did hear him.",
      keepHours: VOICE_REPLY_HOURS,
    });

    // Spoken to, Tony answers aloud as well (when a voice is configured):
    // cheerfully when a task was just ticked off, softly late in the evening.
    // Answered in text. Spoken only when he asks for it ("say it", "tell me") or with /voice on:
    // then the reply's prose, a short natural summary; the list or table stays in the chat.
    const voiceId = await sayAloud(bot, ctx.chat.id, spokenFromMarkdown(reply), completed ? "completed" : "reply", { asked: asksForVoice(ownWords(text)) });
    if (voiceId !== undefined && confirmed) await track(voiceId, "voice", { deleteAfter: hoursFromNow(VOICE_REPLY_HOURS) });
  });

  // Photos, and any other media that carries a caption or was forwarded.
  tasks.on(["message:photo", "message:video", "message:video_note", "message:document", "message:animation", "message:caption"], (ctx) => shareItem(ctx));

  // A sticker is a nod, not a request: a 👍 back, never "I cannot read that".
  tasks.on("message:sticker", (ctx) => ctx.react("👍").catch(() => undefined));

  tasks.on("message", (ctx) => ctx.reply("Text, a voice note, a photo or a forwarded post, sir; I cannot read that kind of message yet."));

  cached = { token, bot };
  return bot;
}

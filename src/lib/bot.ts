import "server-only";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { MessageOrigin } from "grammy/types";
import { runAction } from "./actions";
import { think } from "./brain";
import { runEvening } from "./briefs";
import {
  CONFIRMATION_HOURS,
  deleteNow,
  editHtml,
  ERROR_MINUTES,
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
import { refuseRepeats } from "./dedupe";
import { env } from "./env";
import { b, code, emphasise, plain } from "./html";
import { loadMedia, mediaLabel, saveMedia, sendMedia, type Media } from "./media";
import { logMessage } from "./messages";
import { handlePollAnswer } from "./polls";
import { finishTask } from "./recurrence";
import { applyPlan, buildPlan, dismissPlan, loadPlan, notePlanMessage, planView, removePlanItem, shiftPlanItem } from "./planner";
import { parseAction } from "./reminder-messages";
import { addScheduledTask, otherReminderMessages, scheduleReminder, taskForReminderMessage } from "./reminders";
import { createLoginCode } from "./session";
import { getSettings, updateSettings } from "./settings";
import { addInboxTask, looksLikeTask, OPEN_STATUSES, type Task } from "./tasks";
import { boldTimes, editRich, sendMarkdown, sendRich, spokenFromMarkdown } from "./rich";
import { cleanFromCommand } from "./sweep";
import { closestCommand, connectTelegram, HELP, knownCommand, TODAY_ALIASES } from "./telegram-setup";
import { addMinutes, formatTime, toWholeMinute } from "./time";
import { BoardNotReady, postBoard, shortLabel, toggleFromBoard } from "./today-board";
import { useOffer } from "./offers";
import { dayFromKey, dayView, inboxView } from "./views";
import { readImage } from "./vision";
import { asksForVoice, DAILY_VOICE_LIMIT, sayAloud, setVoiceMode, voiceState } from "./speech";
import { downloadTelegramFile, MAX_VOICE_SECONDS, transcribeAudio } from "./voice";

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

    // A plan's buttons ("pl:..."): apply it, adjust it, or make a new one.
    if (payload.startsWith("pl:")) {
      const [, action, a, b2, c] = payload.split(":");
      let toast: string | undefined;
      try {
        if (action === "new") {
          const now = new Date();
          const result = await buildPlan({ scope: "day", day: a === "tomorrow" ? addMinutes(now, 24 * 60) : now, now });
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
        if (action === "ap") {
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
          const again = await buildPlan({ scope: plan.scope, day: new Date(`${plan.day.slice(0, 10)}T12:00:00+05:00`), instructions: "Propose different times from before." });
          if ("nothing" in again) toast = again.nothing;
          else plan = again.plan;
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

    if (payload.startsWith("ch:")) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      const { pending_choices: pending } = await getSettings();
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      if (!pending) return;
      const pick = payload.slice(3);
      if (pick === "other") {
        await updateSettings({ pending_note: `You asked him: "${pending.question}". He chose to answer in his own words; his next message is that answer.`, pending_note_at: new Date().toISOString() });
        await say(ctx, "Tell me in your own words, sir.");
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
      await say(ctx, `When would suit for ${b(task.title)}, sir?`);
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

    const edited = base !== undefined && chatId !== undefined && tapped ? await editHtml(bot, chatId, tapped.message_id, `${base}${OUTCOME_MARK}${outcome.text}`, keyboard, isCaption) : false;
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

  /** Sends a proposed plan with [Apply] [Adjust]; it replaces any earlier plan in the chat. */
  const showPlan = async (chatId: number, planId: number) => {
    const plan = await loadPlan(planId);
    if (!plan) return;
    const view = await planView(plan);
    await retire({ kinds: ["plan"] });
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
      let host = link;
      try {
        host = new URL(link).hostname.replace(/^www\./, "");
      } catch {
        // keep the link as it is
      }
      const summary = spokenFromMarkdown(reply).slice(0, 400);
      const { data, error } = await requireDb()
        .from("offers")
        .insert({ kind: "link", payload: { url: link, title: (page?.title ?? host).slice(0, 200), summary } })
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

  /** The last sentence of a reply, when it is a yes-or-no question ("Shall I move it to 18:00?"). */
  const yesNoQuestion = (reply: string): string | undefined => {
    const last = reply.trim().split("\n").pop()?.trim() ?? "";
    const match = /(?:^|[.!]\s+)((?:shall|should|may|can|could|do you want|would you like|want)\b[^?]{2,200}\?)$/i.exec(last.replace(/[*_]/g, ""));
    return match?.[1];
  };

  const MUTATING = ["add_task", "update_task", "complete_task", "set_reminder", "remember", "forget"];

  // One path for typed and spoken messages: the brain, with a safe fallback.
  // Returns what Tony said and whether it was a confirmation of something done.
  const answer = async (ctx: Context, text: string, options: { note?: string; keepHours?: number; link?: string } = {}): Promise<{ reply: string; confirmed: boolean; completed: boolean }> => {
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
      const { reply, tools, titles, planId, choices, mediaIds, offerIds, fetched } = await think(text, { channel: "telegram", context }).finally(() => clearInterval(typing));
      // Whatever he was asked before has now been answered or overtaken.
      await updateSettings({ pending_note: null, pending_note_at: null, ...(choices ? {} : { pending_choices: null }) }).catch(() => undefined);
      if (mediaIds?.length && ctx.chat) {
        // "Show my video ideas": the originals come back, each with its label.
        for (const id of mediaIds) {
          const item = await loadMedia(id);
          if (item) await sendMedia(bot, ctx.chat.id, item, emphasise(mediaLabel(item))).catch((error) => console.error("Could not resend media:", error));
        }
      }
      if (planId !== undefined && ctx.chat) {
        await showPlan(ctx.chat.id, planId);
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
      // A yes-or-no question left in the words still gets buttons: he taps, he does not type.
      const yesNo = choices || keyboard ? undefined : yesNoQuestion(reply);
      if (yesNo) {
        keyboard = new InlineKeyboard().text("Yes", "ch:0").text("No", "ch:1");
        await updateSettings({ pending_choices: { question: yesNo, options: ["Yes", "No"] } });
      }
      // The reply as a rich message (lists, tables, headings), times in bold; a confirmation is tidied away later.
      // A confirmation names its task in bold, as it did before.
      const named = confirmed ? titles.reduce((text, title) => (title && text.includes(title) && !text.includes(`**${title}**`) ? text.replace(title, `**${title}**`) : text), reply) : reply;
      const sent = await sendMarkdown(bot, ctx.chat!.id, boldTimes(named), { keyboard });
      if (confirmed) await track(sent, "confirmation", { deleteAfter: hoursFromNow(options.keepHours ?? CONFIRMATION_HOURS) });
      // A small acknowledgement on his own message when something was written down or ticked off.
      const reaction = tools.includes("complete_task")
        ? "👌"
        : tools.some((tool) => ["add_task", "set_reminder", "remember"].includes(tool))
          ? "✍"
          : undefined;
      if (reaction) await ctx.react(reaction).catch(() => undefined);
      return { reply, confirmed, completed: tools.includes("complete_task") };
    } catch (error) {
      // Capture must never fail: if the model is down, keep his words safe. But a question or a
      // bit of conversation is not a task, so it is not saved; he is asked to try again instead.
      console.error("Brain failed:", error);
      if (!looksLikeTask(text)) {
        const reply = "My thinking is briefly unavailable, sir. Ask me again in a minute.";
        const deleteAfter = new Date(Date.now() + ERROR_MINUTES * 60_000);
        await say(ctx, reply, { kind: "error", deleteAfter });
        if (ctx.message && !ctx.message.voice) await track(ctx.message.message_id, "error", { incoming: true, deleteAfter });
        return { reply, confirmed: false, completed: false };
      }
      const task = await addInboxTask(text);
      const reply = `My thinking is briefly unavailable, sir, so I saved "${task.title}" to the inbox as it stands.`;
      await logMessage("tony", reply);
      // His words are safe in the inbox, so the apology (and, unless spoken, his message) go after ten minutes.
      const deleteAfter = new Date(Date.now() + ERROR_MINUTES * 60_000);
      await say(ctx, `My thinking is briefly unavailable, sir, so I saved ${b(task.title)} to the inbox as it stands.`, { kind: "error", deleteAfter });
      if (ctx.message && !ctx.message.voice) await track(ctx.message.message_id, "error", { incoming: true, deleteAfter });
      return { reply, confirmed: false, completed: false };
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
    const words = (message.text ?? message.caption ?? "").trim();
    // An album arrives as one message per photo; only the captioned one is read.
    if (message.media_group_id && !words) return;
    await ctx.replyWithChatAction("typing").catch(() => undefined);

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
            : undefined;

    let imageText: string | undefined;
    let imageFailed = false;
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
      }
      saved = await saveMedia({ kind: file.kind, fileId: file.id, uniqueId: file.unique, mime: file.mime, caption: words, description: imageText, bytes }).catch(
        (error) => (console.error("Could not save the media:", error), undefined),
      );
    }
    if (!words && !imageText && !file) {
      return oops(ctx, "Text, a voice note, a photo, a file or a forwarded post, sir; I cannot read that kind of message yet.");
    }

    const forwarded = message.forward_origin ? originOf(message.forward_origin) : undefined;
    const thing = file ? (file.kind === "photo" ? "photo" : file.kind === "animation" ? "GIF" : file.kind) : "post";
    const image = imageText ? `Text in the image: ${imageText}` : imageFailed ? "(Its image could not be read.)" : file && file.kind !== "photo" ? `(A ${thing}; you cannot see inside it.)` : undefined;
    // What Tony keeps as "the last thing he shared".
    const shared = [
      forwarded ? `${file ? `A ${thing}` : "Post"} forwarded from ${forwarded}` : `A ${thing} he sent`,
      forwarded ? words : words ? `He wrote with it: ${words}` : undefined,
      image,
      saved ? "(Saved. It can be attached to a task or filed under a label.)" : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    // What the brain is asked: his own caption is his words; a forwarded post is all material.
    const asked = forwarded ? `[He forwarded this to you]\n${shared}` : words ? `${words}\n\n[He attached a ${thing}. ${image ?? ""}]` : `[He sent you a ${thing}]\n${image ?? ""}`;

    // Known before Tony thinks, so "remind me about this tomorrow" in the caption can attach it at once.
    if (saved) await updateSettings({ last_shared_media_id: saved.id }).catch(() => undefined);
    try {
      await answer(ctx, asked);
    } finally {
      if (!saved) await updateSettings({ last_shared_media_id: null }).catch(() => undefined);
      await updateSettings({ last_shared_text: shared.slice(0, 2000), last_shared_at: new Date().toISOString() }).catch((error) =>
        console.error("Could not remember the shared item:", error),
      );
    }
  };

  tasks.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      const guess = closestCommand(text);
      return oops(ctx, guess ? `I don't know that command, sir. Did you mean /${guess}?` : "I don't know that command, sir. /help lists the ones I do.");
    }
    if (!text) return;
    // A forwarded post is material to read, not something he typed.
    if (ctx.message.forward_origin) return shareItem(ctx);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    // A link: Tony reads the page and sums it up; Save and Task buttons come under the summary.
    const link = /https?:\/\/[^\s<>"]+/i.exec(text)?.[0]?.replace(/[).,!?]+$/, "");
    const { reply } = await answer(ctx, text, link ? {
      link,
      note: `He sent a link: ${link}. Read it with web_fetch and sum it up: one line on what it is, then the key points as a short list. If he also asked something about it, answer that. Do not add a task or save anything yourself: Save and Task buttons are shown under your reply.`,
    } : {});
    // "Tell me what's left", "say it": he asked to hear it, so the summary is spoken too.
    if (asksForVoice(text)) {
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
    const voiceId = await sayAloud(bot, ctx.chat.id, spokenFromMarkdown(reply), completed ? "completed" : "reply", { asked: asksForVoice(text) });
    if (voiceId !== undefined && confirmed) await track(voiceId, "voice", { deleteAfter: hoursFromNow(VOICE_REPLY_HOURS) });
  });

  // Photos, and any other media that carries a caption or was forwarded.
  tasks.on(["message:photo", "message:video", "message:document", "message:animation", "message:caption"], (ctx) => shareItem(ctx));

  tasks.on("message", (ctx) => ctx.reply("Text, a voice note, a photo or a forwarded post, sir; I cannot read that kind of message yet."));

  cached = { token, bot };
  return bot;
}

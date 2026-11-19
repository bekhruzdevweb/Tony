import "server-only";
import type { Bot } from "grammy";

export const COMMANDS = [
  { command: "today", description: "What is due today" },
  { command: "tomorrow", description: "Tomorrow's plan" },
  { command: "inbox", description: "Tasks without a date" },
  { command: "app", description: "Open the app, or get a key for it" },
  { command: "help", description: "What Tony can do" },
  { command: "ping", description: "Check that Tony is awake" },
];

export const HELP = [
  "At your service, sir. Tell me in your own words, typed or spoken:",
  "• \"Remind me to work out at 6 pm\" becomes a task with a reminder.",
  "• \"Buy a notebook\" goes to the inbox until you give it a date.",
  "• \"Move the slides to tomorrow at 9\", \"I've done the reading\", \"drop the notebook\".",
  "• \"What's left today?\"",
  "• \"I work out in the evenings\" and I shall remember it.",
  "Reply to one of my reminders and I know which task you mean.",
  "Forward me a post or send a photo and I shall read it and offer to make it a task.",
  "",
  "/today  /tomorrow  /inbox  /app  /help  /ping",
].join("\n");

/** What Telegram should send Tony: messages, button taps, and votes in his polls. */
export const ALLOWED_UPDATES = ["message", "callback_query", "poll_answer", "business_connection"] as const;

/**
 * The bot's command list, its Menu button and its webhook. With an https
 * address the Menu button opens the app inside Telegram (the Mini App), and
 * with the webhook secret the webhook is pointed at that address too, which
 * is how a new kind of update (poll votes) gets switched on.
 */
export async function connectTelegram(bot: Bot, appUrl: string | null | undefined, secret?: string): Promise<{ menuButton: boolean }> {
  await bot.api.setMyCommands(COMMANDS);
  if (!appUrl?.startsWith("https://")) return { menuButton: false };
  const base = appUrl.replace(/\/+$/, "");
  if (secret) {
    await bot.api.setWebhook(`${base}/api/telegram/webhook`, { secret_token: secret, allowed_updates: [...ALLOWED_UPDATES] });
  }
  await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Tony", web_app: { url: base } } });
  return { menuButton: true };
}

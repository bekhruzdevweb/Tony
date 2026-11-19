import "server-only";
import type { Bot } from "grammy";

export const COMMANDS = [
  { command: "today", description: "What is due today" },
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
  "",
  "/today  /inbox  /app  /help  /ping",
].join("\n");

/**
 * The bot's command list and its Menu button. With an https address the
 * Menu button opens the app inside Telegram (the Mini App).
 */
export async function connectTelegram(bot: Bot, appUrl: string | null | undefined): Promise<{ menuButton: boolean }> {
  await bot.api.setMyCommands(COMMANDS);
  if (!appUrl?.startsWith("https://")) return { menuButton: false };
  await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Tony", web_app: { url: appUrl } } });
  return { menuButton: true };
}

import "server-only";
import type { Bot } from "grammy";

export const COMMANDS = [
  { command: "today", description: "Re-send and pin the Today checklist" },
  { command: "tomorrow", description: "Tomorrow's plan" },
  { command: "plan", description: "Let Tony plan the day (or: /plan week)" },
  { command: "inbox", description: "Tasks without a date" },
  { command: "app", description: "Open the app, or get a key for it" },
  { command: "voice", description: "When I speak: /voice on, off or auto" },
  { command: "clean", description: "Clear the chat (keeps the board, open reminders, the brief)" },
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
  "• \"Plan my day\", \"plan the week\", \"schedule them yourself\": I propose times and you tap Apply.",
  "",
  "/today (or /list)  /tomorrow  /plan  /inbox  /voice  /clean  /app  /help  /ping",
].join("\n");

/** What Telegram should send Tony: messages, button taps, and votes in his polls. */
export const ALLOWED_UPDATES = ["message", "callback_query", "poll_answer"] as const;

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

/** Other names for /today. */
export const TODAY_ALIASES = ["checklist", "list"];

/** Every command Tony answers, including the ones kept out of the menu. */
const KNOWN_COMMANDS = [...COMMANDS.map((entry) => entry.command), ...TODAY_ALIASES, "start", "test"];

/** The command a message starts with ("today" for "/today@TonyBot now"), if Tony knows it. */
export function knownCommand(text: string | undefined): string | undefined {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text ?? "");
  const command = match?.[1].toLowerCase();
  return command && KNOWN_COMMANDS.includes(command) ? command : undefined;
}

/** Edit distance: how many single-letter changes turn one word into the other. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, n) => n);
  for (let x = 1; x <= a.length; x++) {
    let previous = row[0];
    row[0] = x;
    for (let y = 1; y <= b.length; y++) {
      const kept = row[y];
      row[y] = Math.min(row[y] + 1, row[y - 1] + 1, previous + (a[x - 1] === b[y - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

/**
 * The command he most likely meant by a mistyped one ("/tody" gives
 * "today"), or undefined when nothing is close enough to be worth guessing.
 */
export function closestCommand(typed: string): string | undefined {
  const word = typed.trim().replace(/^\//, "").split(/[\s@]/)[0].toLowerCase();
  if (!word) return undefined;
  let best: { command: string; score: number } | undefined;
  for (const command of KNOWN_COMMANDS) {
    // A typed beginning ("/tom") counts as close; otherwise allow about one slip per three letters.
    // Two neighbouring letters swapped ("/hlep") is one slip, not two.
    const swapped = word.length === command.length && [...word].some((_, n) => n + 1 < word.length && word.slice(0, n) + word[n + 1] + word[n] + word.slice(n + 2) === command);
    const score = command.startsWith(word) && word.length >= 2 ? 0.5 : swapped ? 1 : distance(word, command);
    if (score <= Math.max(1, Math.floor(command.length / 3)) && (!best || score < best.score)) best = { command, score };
  }
  return best?.command;
}

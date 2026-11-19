import "server-only";
import type { AppMemory, AppMessage, AppPlan, AppProject, AppState } from "./app-types";
import { getBot } from "./bot";
import { requireDb } from "./db";
import { mediaForApp } from "./media";
import { env } from "./env";
import { getClockStatus, getSettings } from "./settings";
import { OPEN_STATUSES, type Task } from "./tasks";

const clock = (value: string) => value.slice(0, 5);

/** Everything the app shows, in one read. The app re-reads it every few seconds. */
export async function loadAppState(now = new Date()): Promise<AppState> {
  const db = requireDb();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const [open, closed, projects, memory, messages, plans, settings, clockStatus] = await Promise.all([
    db.from("tasks").select().in("status", OPEN_STATUSES).order("due_at", { ascending: true, nullsFirst: false }).order("id").limit(500),
    // Recently finished tasks stay visible, struck through, for a day.
    db.from("tasks").select().in("status", ["done", "skipped"]).gte("updated_at", dayAgo).order("updated_at", { ascending: false }).limit(50),
    db.from("projects").select().order("sort_order").order("id"),
    db.from("memory").select().order("id", { ascending: false }),
    db.from("messages").select().order("id", { ascending: false }).limit(80),
    db.from("plans").select().order("id", { ascending: false }).limit(8),
    getSettings(),
    getClockStatus(now),
  ]);
  for (const result of [open, closed, projects, memory, messages, plans]) {
    if (result.error) throw new Error(`loadAppState: ${result.error.message}`);
  }

  const shown = [...(open.data as Task[]), ...(closed.data as Task[])];
  // Attachments are a nicety: if they cannot be read, the tasks still load.
  const media = await mediaForApp(shown.map((task) => task.id), now).catch((error) => (console.error("App media failed:", error), []));

  const bot = getBot();
  let botUsername: string | null = null;
  if (bot) {
    try {
      await bot.init();
      botUsername = bot.botInfo.username;
    } catch {
      botUsername = null;
    }
  }

  return {
    now: now.toISOString(),
    tasks: shown,
    media,
    projects: projects.data as AppProject[],
    memory: memory.data as AppMemory[],
    messages: (messages.data as AppMessage[]).reverse(),
    plans: plans.data as AppPlan[],
    settings: {
      brief_morning: clock(settings.brief_morning),
      brief_evening: clock(settings.brief_evening),
      quiet_start: clock(settings.quiet_start),
      quiet_end: clock(settings.quiet_end),
      persistent_schedule: settings.persistent_schedule,
    },
    status: {
      telegram: Boolean(env.telegramBotToken && env.telegramWebhookSecret && env.telegramOwnerId !== undefined),
      database: true,
      brain: Boolean(env.aiApiKey),
      clock: clockStatus.ready,
      lastTick: clockStatus.lastTick?.toISOString() ?? null,
      model: env.aiModel,
      voiceModel: env.sttModel,
      botUsername,
    },
  };
}

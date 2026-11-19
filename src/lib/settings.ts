import "server-only";
import { requireDb } from "./db";

export type Settings = {
  timezone: string;
  brief_morning: string;
  brief_evening: string;
  quiet_start: string;
  quiet_end: string;
  persistent_schedule: number[];
  app_url: string | null;
  tick_secret: string;
  last_tick_at: string | null;
  session_secret: string;
  login_token_hash: string | null;
  login_token_expires_at: string | null;
};

export async function getSettings(): Promise<Settings> {
  const { data, error } = await requireDb().from("settings").select().limit(1).single();
  if (error) throw new Error(`getSettings: ${error.message}`);
  return data as Settings;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const { error } = await requireDb().from("settings").update(patch).eq("id", true);
  if (error) throw new Error(`updateSettings: ${error.message}`);
}

/** Whether the once-a-minute clock is getting through. */
export async function getClockStatus(now = new Date()): Promise<{ lastTick?: Date; ready: boolean }> {
  try {
    const { last_tick_at } = await getSettings();
    if (!last_tick_at) return { ready: false };
    const lastTick = new Date(last_tick_at);
    // Allow a couple of missed minutes before calling it stopped.
    return { lastTick, ready: now.getTime() - lastTick.getTime() < 3 * 60_000 };
  } catch {
    return { ready: false };
  }
}

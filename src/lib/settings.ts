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
  last_shared_text: string | null;
  last_shared_at: string | null;
  today_message_id: number | null;
  /** The pinned one-line banner above the board. */
  today_status_id?: number | null;
  today_message_day: string | null;
  today_message_hash: string | null;
  last_shared_media_id: number | null;
  pending_choices: { question: string; options: string[] } | null;
  /** The guided weekly planning in progress (Phase R, migration 0036); null when none. */
  week_session?: { week: string; kept: number[]; placed: number; someday: number; dropped: number } | null;
  pending_note: string | null;
  pending_note_at: string | null;
  /** After [✏️ Other time]: the task waiting for the time he types next (migration 0023); after [🧩 Steps], for its steps. */
  pending_slot?: { task_id: number; day?: string; steps?: boolean } | null;
  pending_slot_at?: string | null;
};

/** How long a tapped [✏️ Other time] waits for the time he types. */
const SLOT_MINUTES = 30;

/**
 * Keeps (or clears) the task waiting for a typed time. Before migration 0023
 * the columns are missing: nothing is kept, and Tony's note to the brain does
 * the job instead. Never fails the tap.
 */
export async function setPendingSlot(slot: { task_id: number; day?: string; steps?: boolean } | null, now = new Date()): Promise<void> {
  const { error } = await requireDb()
    .from("settings")
    .update({ pending_slot: slot, pending_slot_at: slot ? now.toISOString() : null })
    .eq("id", true);
  if (error) console.warn(`setPendingSlot: ${error.message}`);
}

/** The task waiting for a typed time, if he tapped [✏️ Other time] in the last half hour. */
export async function waitingSlot(now = new Date()): Promise<{ task_id: number; day: string } | { task_id: number; steps: true } | undefined> {
  const settings = await getSettings().catch(() => undefined);
  const slot = settings?.pending_slot;
  if (!slot || !settings?.pending_slot_at || !Number.isFinite(Number(slot.task_id))) return undefined;
  if (now.getTime() - new Date(settings.pending_slot_at).getTime() > SLOT_MINUTES * 60_000) return undefined;
  if (slot.steps) return { task_id: Number(slot.task_id), steps: true };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(slot.day))) return undefined;
  return { task_id: Number(slot.task_id), day: String(slot.day) };
}

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

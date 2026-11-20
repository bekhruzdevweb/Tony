import "server-only";
import { checkClaude } from "./brain/model";
import { requireDb } from "./db";
import { env } from "./env";
import { logEvent } from "./events";
import { getSettings } from "./settings";
import { dayBounds, TIMEZONE } from "./time";

/**
 * The 07:00 self-test (phase e, 21 Nov): the AI answers, the voice key works,
 * today's prayer times are in, the reminder clock ticks and nothing is stuck.
 * All well: noted, nothing sent. Anything broken: ONE message saying what.
 */
export async function selfTest(now = new Date()): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = (good: boolean, label: string, why?: string) => {
    if (!good) ok = false;
    lines.push(`${good ? "✓" : "✗"} ${label}${!good && why ? `: ${why}` : ""}`);
  };

  const ai = await checkClaude().catch((error) => String(error));
  check(ai === undefined, "AI", ai);

  if (env.elevenLabsApiKey) {
    let voice: string | undefined;
    try {
      const response = await fetch(`${env.elevenLabsBaseUrl}/v1/user/subscription`, { headers: { "xi-api-key": env.elevenLabsApiKey }, signal: AbortSignal.timeout(6_000) });
      if (!response.ok) voice = `ElevenLabs answered ${response.status}`;
    } catch (error) {
      voice = `ElevenLabs unreachable (${error instanceof Error ? error.message : error})`;
    }
    check(voice === undefined, "Voice", voice);
  }

  const { start, end } = dayBounds(now, TIMEZONE);
  const prayers = await requireDb().from("tasks").select("id", { count: "exact", head: true }).eq("kind", "prayer").gte("due_at", start.toISOString()).lt("due_at", end.toISOString());
  check(!prayers.error && (prayers.count ?? 0) >= 5, "Prayer times", prayers.error ? prayers.error.message : `${prayers.count ?? 0} of 5 for today`);

  const settings = await getSettings().catch(() => undefined);
  const tick = settings?.last_tick_at ? (now.getTime() - new Date(settings.last_tick_at).getTime()) / 60_000 : Infinity;
  const stuck = await requireDb().from("reminders").select("id", { count: "exact", head: true }).eq("state", "scheduled").lt("fire_at", new Date(now.getTime() - 15 * 60_000).toISOString());
  const why = tick > 5 ? `the clock last ticked ${Number.isFinite(tick) ? `${Math.round(tick)} minutes ago` : "never"}` : (stuck.count ?? 0) > 0 ? `${stuck.count} reminder(s) overdue by 15+ minutes` : undefined;
  check(why === undefined, "Reminders", why);

  await logEvent("selftest", { ok, lines });
  return { ok, lines };
}

/** The one message when something is broken. */
export const selfTestAlert = (result: { lines: string[] }) => `⚠️ **Morning check**: something is not working.\n${result.lines.join("\n")}`;

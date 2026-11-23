import { timingSafeEqual } from "node:crypto";
import { dryRun } from "@/lib/brain";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { getSettings } from "@/lib/settings";

export const maxDuration = 60;

function matches(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A replay of his past messages (23 Nov: "what can we do to avoid such dumb mistakes"): each message is put
 * to Tony's model again, with the history it had, and what the model would do is noted (its words and the
 * tools it would call). Nothing is carried out, nothing is sent, no task changes. Called by the database
 * with the clock's own password, like the tick.
 */
export async function POST(request: Request) {
  const db = getDb();
  if (!db) return Response.json({ ok: false }, { status: 503 });
  const { tick_secret } = await getSettings();
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!tick_secret || !matches(given, tick_secret)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const run = (url.searchParams.get("run") ?? "r1").slice(0, 20);
  const from = Number(url.searchParams.get("from") ?? 0);
  const started = Date.now();
  const done = await db.from("events").select("detail").eq("kind", "replay").eq("detail->>run", run).limit(2000);
  const seen = new Set(((done.data ?? []) as { detail: { message_id?: number } }[]).map((row) => Number(row.detail?.message_id)));
  const todo = await db.from("messages").select("id").eq("role", "user").gte("id", from).order("id").limit(500);
  const ids = ((todo.data ?? []) as { id: number }[]).map((row) => row.id).filter((id) => !seen.has(id));
  let handled = 0;
  for (let at = 0; at < ids.length && Date.now() - started < 38_000; at += 4) {
    await Promise.all(
      ids.slice(at, at + 4).map(async (id) => {
        const result = await dryRun(id).catch((error) => ({ error: String(error instanceof Error ? error.message : error).slice(0, 300) }));
        await logEvent("replay", { run, message_id: id, ...result });
        handled++;
      }),
    );
  }
  return Response.json({ ok: true, handled, left: ids.length - handled });
}

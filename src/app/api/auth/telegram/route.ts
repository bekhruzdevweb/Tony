import { startSession } from "@/lib/session";
import { isOwnerInitData } from "@/lib/telegram-auth";

/**
 * Sign-in from inside Telegram (the Mini App): no key to type, because
 * Telegram itself vouches for who opened it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { initData?: unknown };
  if (typeof body.initData !== "string" || !isOwnerInitData(body.initData)) {
    return Response.json({ ok: false, error: "Telegram could not confirm it is you." }, { status: 401 });
  }
  // A cookie as well, where the Telegram client keeps them; requests also carry initData.
  await startSession().catch(() => undefined);
  return Response.json({ ok: true });
}

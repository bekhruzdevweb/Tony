import { redeemLoginCode, startSession } from "@/lib/session";

/** The link Tony sends in Telegram: trades the code for a session, then opens the app. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ok = await redeemLoginCode(url.searchParams.get("code") ?? "").catch(() => false);
  if (ok) await startSession();
  return Response.redirect(new URL(ok ? "/" : "/?login=expired", url.origin), 303);
}

/** The code typed into the app's sign-in screen (the only way into an installed app on iOS). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code : "";
  const ok = code ? await redeemLoginCode(code).catch(() => false) : false;
  if (!ok) return Response.json({ ok: false, error: "That code is wrong or has expired. Send /app to Tony for a new one." }, { status: 401 });
  await startSession();
  return Response.json({ ok: true });
}

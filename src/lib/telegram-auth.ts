import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/** How old a Mini App sign-in may be. Telegram issues a new one each time the app is opened. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Checks the initData string a Telegram Mini App hands to its page, the way
 * Telegram documents it: the data is signed with a key derived from the bot
 * token, so only Telegram could have produced it. Returns true only for a
 * fresh, correctly signed sign-in by Tony's owner.
 */
export function isOwnerInitData(initData: string, now = Date.now()): boolean {
  const token = env.telegramBotToken;
  const ownerId = env.telegramOwnerId;
  if (!token || ownerId === undefined || !initData || initData.length > 4096) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");

  const checkString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > MAX_AGE_SECONDS) return false;

  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number };
    return user.id === ownerId;
  } catch {
    return false;
  }
}

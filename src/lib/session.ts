import "server-only";
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getDb } from "./db";
import { getSettings, updateSettings } from "./settings";
import { isOwnerInitData } from "./telegram-auth";

/**
 * Sign-in for the app. Tony has one user, who is already proven by his
 * Telegram chat: he sends /app, Tony replies with a six-digit code (and a
 * link carrying it), and the app trades the code for a long-lived cookie.
 * A code works once, for ten minutes, and a single wrong guess voids it.
 */
export const SESSION_COOKIE = "tony_session";
const SESSION_DAYS = 90;
const CODE_MINUTES = 10;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A fresh code, stored only as a hash. */
export async function createLoginCode(): Promise<{ code: string; appUrl: string | null }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await updateSettings({
    login_token_hash: sha256(code),
    login_token_expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
  });
  const { app_url } = await getSettings();
  return { code, appUrl: app_url ? app_url.replace(/\/+$/, "") : null };
}

/** True once, for the right code. Any attempt, right or wrong, uses the code up. */
export async function redeemLoginCode(code: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.login_token_hash || !settings.login_token_expires_at) return false;
  await updateSettings({ login_token_hash: null, login_token_expires_at: null });
  if (new Date(settings.login_token_expires_at).getTime() < Date.now()) return false;
  return same(sha256(code.replace(/\D/g, "")), settings.login_token_hash);
}

function sign(expires: number, secret: string) {
  return createHmac("sha256", secret).update(`tony-session:${expires}`).digest("base64url");
}

export async function startSession(): Promise<void> {
  const { session_secret } = await getSettings();
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60_000;
  (await cookies()).set(SESSION_COOKIE, `${expires}.${sign(expires, session_secret)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax keeps other sites from making requests with this cookie. Inside
    // Telegram, requests carry Telegram's own signed data instead.
    sameSite: "lax",
    path: "/",
    expires: new Date(expires),
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The header a Mini App request carries: Telegram's signed sign-in data. */
export const INIT_DATA_HEADER = "x-telegram-init-data";

/** Whether this request comes from the signed-in owner. */
export async function hasSession(): Promise<boolean> {
  // Inside Telegram, each request proves itself; no cookie is needed (some
  // Telegram clients run the app in a frame where cookies are not kept).
  const initData = (await headers()).get(INIT_DATA_HEADER);
  if (initData && isOwnerInitData(initData)) return true;

  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value || !getDb()) return false;
  const [expiresText, signature] = value.split(".");
  const expires = Number(expiresText);
  if (!signature || !Number.isFinite(expires) || expires < Date.now()) return false;
  try {
    const { session_secret } = await getSettings();
    return same(signature, sign(expires, session_secret));
  } catch {
    return false;
  }
}

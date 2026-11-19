import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let cached: { key: string; client: SupabaseClient } | undefined;

/** Server-side database client, or undefined while Supabase is not configured. */
export function getDb(): SupabaseClient | undefined {
  const url = env.supabaseUrl;
  const secretKey = env.supabaseSecretKey;
  if (!url || !secretKey) return undefined;

  const key = `${url}\n${secretKey}`;
  if (cached?.key === key) return cached.client;

  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  cached = { key, client };
  return client;
}

export function requireDb(): SupabaseClient {
  const db = getDb();
  if (!db) throw new Error("Supabase is not configured");
  return db;
}

/** True once the migration has been applied and the server can read it. */
export async function isDatabaseReady(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const { error } = await db.from("settings").select("id").limit(1);
  return !error;
}

import "server-only";
import { requireDb } from "./db";

export type Channel = "telegram" | "app";
export type StoredMessage = { id: number; role: "user" | "tony"; text: string; channel: Channel; created_at: string };

/** The one conversation shared by Telegram and the app. Never throws: a lost log line must not lose a reply. */
export async function logMessage(role: "user" | "tony", text: string, channel: Channel = "telegram"): Promise<void> {
  try {
    const { error } = await requireDb().from("messages").insert({ role, text, channel });
    if (error) console.error("logMessage:", error.message);
  } catch (error) {
    console.error("logMessage:", error);
  }
}

/** The most recent messages, oldest first. */
export async function recentMessages(limit: number): Promise<StoredMessage[]> {
  const { data, error } = await requireDb()
    .from("messages")
    .select()
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recentMessages: ${error.message}`);
  return (data as StoredMessage[]).reverse();
}

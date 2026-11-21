import "server-only";
import { requireDb } from "./db";
import type { MemoryNote } from "./memory-rules";

/**
 * /memory: what Tony keeps about him, and forgetting one note on a tap.
 * Plain code, never the AI model.
 */

export type MemoryRow = MemoryNote & { source: string | null };

/** Every memory note, oldest first, with its layer (always, this month, this week). */
export async function memoryList(): Promise<MemoryRow[]> {
  const { data, error } = await requireDb().from("memory").select("id, fact, source, layer, goal, mentions, confirmed_at, created_at").order("id");
  if (error) throw new Error(`memoryList: ${error.message}`);
  return (data ?? []) as MemoryRow[];
}

/** Deletes one note and says which; read back from the delete itself. */
export async function forgetFact(id: number): Promise<string> {
  const { data, error } = await requireDb().from("memory").delete().eq("id", id).select("fact");
  if (error) throw new Error(`forgetFact: ${error.message}`);
  const removed = (data ?? []) as { fact: string }[];
  return removed.length ? `🗑 Forgotten: ${removed[0].fact}` : "That note was already gone, sir.";
}

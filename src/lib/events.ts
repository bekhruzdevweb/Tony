import "server-only";
import { requireDb } from "./db";

/**
 * Things worth knowing later (migration 0022): the model failing to answer,
 * and, from Phase 4, fallbacks and self-test results. Never throws: a lost
 * log line must not cost him a reply.
 */
export async function logEvent(kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const { error } = await requireDb().from("events").insert({ kind, detail });
    if (error) console.error(`logEvent: ${error.message}`);
  } catch (error) {
    console.error("logEvent:", error);
  }
}

import "server-only";
import { requireDb } from "./db";
import { addScheduledTask } from "./reminders";
import { addInboxTask } from "./tasks";
import { formatDue } from "./time";

/**
 * What a button under one of Tony's replies does. Plain code, no AI:
 * - "t": a task Tony offered in conversation ([➕ Make this a task]);
 * - "s": save a link he sent ([💾 Save]), as a memory note Tony can find again;
 * - "k": turn that link into a task ([➕ Task]), "Read: <title>", with the link in its notes.
 * Each button works once.
 */
type Offer = {
  id: number;
  kind: "task" | "link";
  payload: { title?: string; due_at?: string; url?: string; summary?: string };
  used_as: string | null;
};

export async function useOffer(how: string, id: number, now = new Date()): Promise<{ used: boolean; toast: string }> {
  const db = requireDb();
  const found = await db.from("offers").select("id, kind, payload, used_as").eq("id", id).maybeSingle();
  if (found.error) throw new Error(`useOffer: ${found.error.message}`);
  const offer = found.data as Offer | null;
  if (!offer) return { used: false, toast: "That offer has gone, sir." };
  const done = (offer.used_as ?? "").split(",").filter(Boolean);
  const action = how === "t" ? "task" : how === "s" ? "saved" : how === "k" ? "task" : undefined;
  if (!action) return { used: false, toast: "I don't know that button, sir." };
  if (done.includes(action)) return { used: true, toast: "Already done, sir." };

  let toast: string;
  if (offer.kind === "task" && how === "t") {
    const title = offer.payload.title ?? "Untitled";
    const due = offer.payload.due_at ? new Date(offer.payload.due_at) : undefined;
    if (due && due.getTime() > now.getTime()) {
      await addScheduledTask({ title, dueAt: due });
      toast = `Added: ${title}, ${formatDue(due, now)}.`;
    } else {
      await addInboxTask(title);
      toast = `Added to the inbox: ${title}.`;
    }
  } else if (offer.kind === "link" && how === "s") {
    const fact = `Saved link: ${offer.payload.title ?? offer.payload.url} (${offer.payload.url})${offer.payload.summary ? `. ${offer.payload.summary}` : ""}`.slice(0, 300);
    const { error } = await db.from("memory").insert({ fact, source: "link" });
    if (error) throw new Error(`useOffer: ${error.message}`);
    toast = "Saved, sir. Ask me for it any time.";
  } else if (offer.kind === "link" && how === "k") {
    const title = `Read: ${offer.payload.title ?? offer.payload.url}`.slice(0, 200);
    const task = await addInboxTask(title);
    await db.from("tasks").update({ notes: offer.payload.url }).eq("id", task.id);
    toast = `Added to the inbox: ${title}.`;
  } else {
    return { used: false, toast: "That button does not fit this offer, sir." };
  }

  await db
    .from("offers")
    .update({ used_at: now.toISOString(), used_as: [...done, action].join(",") })
    .eq("id", offer.id);
  return { used: true, toast: toast.slice(0, 190) };
}

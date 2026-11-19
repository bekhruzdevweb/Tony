import type { AppResult } from "@/lib/app-types";
import { loadAppState } from "@/lib/app-state";
import { respond } from "@/lib/brain";
import { hasSession } from "@/lib/session";
import { transcribeAudio } from "@/lib/voice";

export const maxDuration = 60;

const json = (body: AppResult, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The Chat screen's mic button: a short recording, transcribed and handled like a typed message. */
export async function POST(request: Request) {
  if (!(await hasSession())) return json({ ok: false, error: "Signed out" }, 401);

  const type = (request.headers.get("content-type") ?? "audio/webm").split(";")[0];
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ ok: false, error: "The recording was empty" }, 400);
  if (bytes.byteLength > 10 * 1024 * 1024) return json({ ok: false, error: "That recording is too long" }, 413);

  // Browsers record webm (Chrome, Firefox) or mp4 (Safari).
  const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  let text: string;
  try {
    text = await transcribeAudio(bytes, `voice.${extension}`, type);
  } catch (error) {
    console.error("App voice failed:", error);
    return json({ ok: false, error: "I could not hear that one, sir. Try again or type it." }, 502);
  }
  if (!text) return json({ ok: false, error: "I heard only silence, sir." });

  try {
    const reply = await respond(text, "app");
    return json({ ok: true, state: await loadAppState(), reply });
  } catch (error) {
    console.error("Brain failed after voice:", error);
    return json({ ok: false, error: `I heard "${text}" but could not think it through. Try again in a moment.` }, 502);
  }
}

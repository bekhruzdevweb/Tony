import type { AppResult } from "@/lib/app-types";
import { loadAppState } from "@/lib/app-state";
import { respond } from "@/lib/brain";
import { runTool } from "@/lib/brain/tools";
import { requireDb } from "@/lib/db";
import { logMessage } from "@/lib/messages";
import { hasSession } from "@/lib/session";
import { updateSettings } from "@/lib/settings";
import { addInboxTask } from "@/lib/tasks";

// Chat goes through the AI model, which can take a few seconds.
export const maxDuration = 60;

const json = (body: AppResult, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const denied = () => json({ ok: false, error: "Signed out" }, 401);

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** The app's screens read everything from here. */
export async function GET() {
  if (!(await hasSession())) return denied();
  try {
    return json({ ok: true, state: await loadAppState() });
  } catch (error) {
    console.error("App state failed:", error);
    return json({ ok: false, error: "Could not load your tasks" }, 500);
  }
}

type Body = Record<string, unknown> & { action?: string };

/** One endpoint for everything the app changes. Every answer carries the fresh state. */
export async function POST(request: Request) {
  if (!(await hasSession())) return denied();
  const body = (await request.json().catch(() => ({}))) as Body;

  try {
    let reply: string | undefined;
    let problem: string | undefined;

    switch (body.action) {
      // The same code the AI's tools use, so app and Telegram behave alike.
      case "add_task":
      case "update_task":
      case "complete_task":
      case "forget": {
        const result = await runTool(body.action, body);
        if (!result.ok) problem = result.error;
        break;
      }

      // Quick add and Chat: Tony reads it, exactly as he reads a Telegram message.
      case "say": {
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
        if (!text) {
          problem = "Nothing to send";
          break;
        }
        try {
          reply = await respond(text, "app");
        } catch (error) {
          console.error("Brain failed, saving to inbox instead:", error);
          const task = await addInboxTask(text);
          reply = `My thinking is briefly unavailable, sir, so I saved "${task.title}" to the inbox as it stands.`;
          await logMessage("tony", reply, "app");
        }
        break;
      }

      case "settings": {
        const patch: Record<string, unknown> = {};
        for (const key of ["brief_morning", "brief_evening", "quiet_start", "quiet_end"] as const) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== "string" || !CLOCK.test(body[key])) {
            problem = "Times must look like 08:00";
            break;
          }
          patch[key] = body[key];
        }
        if (!problem && body.persistent_schedule !== undefined) {
          const steps = Array.isArray(body.persistent_schedule) ? body.persistent_schedule.map(Number) : [];
          const valid = steps.length > 0 && steps.length <= 12 && steps.every((n) => Number.isInteger(n) && n >= 0 && n <= 24 * 60);
          if (!valid) problem = "The schedule is a list of minutes, such as 0, 15, 30, 60";
          else patch.persistent_schedule = [...new Set(steps)].sort((a, b) => a - b);
        }
        if (!problem && Object.keys(patch).length > 0) await updateSettings(patch);
        break;
      }

      case "add_project": {
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
        const color = typeof body.color === "string" && COLOR.test(body.color) ? body.color : "#5B8BFF";
        if (!name) {
          problem = "A project needs a name";
          break;
        }
        const { error } = await requireDb().from("projects").insert({ name, color, sort_order: 100 });
        if (error) problem = error.code === "23505" ? "That project already exists" : "Could not add the project";
        break;
      }

      default:
        return json({ ok: false, error: "Unknown action" }, 400);
    }

    const state = await loadAppState();
    return problem ? json({ ok: false, error: problem, state }) : json({ ok: true, state, reply });
  } catch (error) {
    console.error(`App action ${body.action} failed:`, error);
    return json({ ok: false, error: "That did not go through. Please try again." }, 500);
  }
}

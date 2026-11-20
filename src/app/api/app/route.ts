import { markdownToPlain } from "@/lib/rich";
import { formatTime } from "@/lib/time";
import type { AppResult } from "@/lib/app-types";
import { loadAppState } from "@/lib/app-state";
import { getBot } from "@/lib/bot";
import { env } from "@/lib/env";
import { refreshBoard } from "@/lib/today-board";
import { handleMessage } from "@/lib/brain/handle";
import { runTool } from "@/lib/brain/tools";
import { rescheduleOverdue } from "@/lib/reschedule";
import { addSubtasks, allDone, removeSubtask, setSubtaskDone } from "@/lib/subtasks";
import { requireDb } from "@/lib/db";
import { applyPlan, buildPlan, dismissPlan } from "@/lib/planner";
import { hasSession } from "@/lib/session";
import { updateSettings } from "@/lib/settings";

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
      // "Reschedule" on Overdue: every overdue task to today or tomorrow, at its own time.
      case "reschedule_overdue": {
        const moved = await rescheduleOverdue(body.to === "tomorrow" ? "tomorrow" : "today");
        reply = moved ? `Moved ${moved} ${moved === 1 ? "task" : "tasks"} to ${body.to === "tomorrow" ? "tomorrow" : "today"}, sir.` : "Nothing overdue, sir.";
        break;
      }

      case "say": {
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
        if (!text) {
          problem = "Nothing to send";
          break;
        }
        // Request by request, as in Telegram; if the model fails twice, nothing is saved.
        const replies: string[] = [];
        for (const item of await handleMessage(text, { channel: "app" })) {
          if (item.kind === "clean") replies.push("The chat in Telegram is cleaned with /clean, sir.");
          else if (item.kind === "failed" || item.kind === "link") replies.push(markdownToPlain(item.reply));
          else {
            const thought = item.thought;
            // The app has no buttons in Chat: a plan waits under Plans, and options are listed.
            if (thought.planId !== undefined) replies.push("I have proposed a plan, sir. It is under Plans (tap my picture), with my reasons and an Apply button.");
            else if (thought.choices) replies.push(`${thought.choices.question} (${thought.choices.options.join(" / ")})`);
            // No buttons in the app's chat: the free slots are named, and a proposal waits for his "yes".
            else if (thought.slot?.kind === "ask") replies.push(`${markdownToPlain(thought.reply)} (${thought.slot.options.map((option) => formatTime(option)).join(" / ")})`);
            else if (thought.slot?.kind === "propose" || thought.proposal) replies.push(`${markdownToPlain(thought.reply)} Say "yes" and it's done.`);
            // The app's chat shows plain text: the rich markdown is flattened (lists stay one per line).
            else replies.push(markdownToPlain(thought.reply));
          }
        }
        reply = replies.join("\n\n");
        break;
      }

      case "plan": {
        const result = await buildPlan({ scope: body.scope === "week" ? "week" : "day" });
        if ("nothing" in result) problem = result.nothing;
        break;
      }

      case "apply_plan":
      case "dismiss_plan": {
        const id = Number(body.id);
        if (!Number.isSafeInteger(id)) {
          problem = "Unknown plan";
          break;
        }
        if (body.action === "apply_plan") {
          const done = await applyPlan(id);
          reply = done.applied ? `Applied, sir: ${done.applied} ${done.applied === 1 ? "task" : "tasks"} scheduled.` : undefined;
          if (!done.applied) problem = "Nothing was left to apply";
        } else {
          await dismissPlan(id);
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

      // A task's parts, from the app: add, tick or untick, remove. Plain code.
      case "add_subtask": {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title || !Number.isFinite(Number(body.task_id))) problem = "A part needs a title";
        else await addSubtasks(Number(body.task_id), [title]);
        break;
      }
      case "tick_subtask": {
        const result = await setSubtaskDone(Number(body.id), body.done !== false);
        if (!result) problem = "That part is gone";
        else if (body.done !== false && allDone(result.subtasks)) reply = "Every part is done, sir. Tick the task itself when you are ready.";
        break;
      }
      case "remove_subtask": {
        await removeSubtask(Number(body.id));
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

    // A change made in the app shows on the pinned Today message in Telegram as well.
    const bot = getBot();
    if (bot && env.telegramOwnerId !== undefined) await refreshBoard(bot, env.telegramOwnerId);

    const state = await loadAppState();
    return problem ? json({ ok: false, error: problem, state }) : json({ ok: true, state, reply });
  } catch (error) {
    console.error(`App action ${body.action} failed:`, error);
    return json({ ok: false, error: "That did not go through. Please try again." }, 500);
  }
}

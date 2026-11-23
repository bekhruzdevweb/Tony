"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { AppPlan, AppState } from "@/lib/app-types";
import { isAlive, LAYER_TITLES, normalNote, type MemoryLayer } from "@/lib/memory-rules";
import type { Task } from "@/lib/tasks";
import { formatDue, formatLongDate, formatTime } from "@/lib/time";
import { Empty, Icon, Section, TaskRow, isOpen } from "./ui";
import { pushBack, tonyFetch, webApp } from "./telegram";
import type { Tony } from "./use-tony";

type View = { name: "menu" } | { name: "project"; id: number } | { name: "settings" } | { name: "plans" };
export type Theme = "system" | "light" | "dark";

const COLORS = ["#5B8BFF", "#7A5CFF", "#34C759", "#FF9F0A", "#FF5A5F", "#64748B"];
const field = "h-11 rounded-card bg-background px-3 outline-none focus:ring-2 focus:ring-primary/40";

const SHOWN_ORDER: MemoryLayer[] = ["week", "month", "always"];

function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5">
      <span className="min-w-0">
        <span className="block text-body">{label}</span>
        {hint && <span className="block text-caption text-secondary">{hint}</span>}
      </span>
      {children}
    </li>
  );
}

function Dot({ ready }: { ready: boolean }) {
  return <span aria-label={ready ? "Ready" : "Not ready"} className={`size-2.5 shrink-0 rounded-full ${ready ? "bg-done" : "bg-overdue"}`} />;
}

/** Opens from the avatar: Projects and Settings. */
export function Menu(props: {
  tony: Tony;
  now: Date;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
  onOpen: (task: Task) => void;
  onToggle: (task: Task) => void;
  /** Phones: the Plan board and Habits open from here (wide screens have them in the sidebar). */
  onGo?: (tab: "habits" | "board") => void;
}) {
  const { tony, now, theme, onTheme, onClose, onOpen, onToggle, onGo } = props;
  const { state, act } = tony;
  const [view, setView] = useState<View>({ name: "menu" });
  // Telegram's Back button: out of a sub-page first, then out of the menu.
  const inSubPage = view.name !== "menu";
  useEffect(() => pushBack(() => (inSubPage ? setView({ name: "menu" }) : onClose())), [inSubPage, onClose]);

  const open = state.tasks.filter(isOpen);
  const project = view.name === "project" ? state.projects.find((p) => p.id === view.id) : undefined;
  const heading = view.name === "settings" ? "Settings" : view.name === "plans" ? "Tony's plans" : project ? project.name : "Tony";

  return (
    <div className="fade-in fixed inset-0 z-30 flex justify-center bg-black/40" onClick={onClose}>
      <div className="menu-in safe-top safe-bottom flex h-full w-full max-w-md flex-col bg-background" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-2 pt-2">
          {view.name === "menu" ? (
            <span className="w-11" />
          ) : (
            <button type="button" aria-label="Back" onClick={() => setView({ name: "menu" })} className="grid size-11 rotate-180 place-items-center text-primary">
              {Icon.chevron}
            </button>
          )}
          <span className="text-sub font-semibold">{heading}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-11 place-items-center text-secondary">
            {Icon.close}
          </button>
        </div>

        <div key={view.name === "project" ? `project:${view.id}` : view.name} className={`flex-1 overflow-y-auto px-4 pb-8 ${view.name === "menu" ? "" : "push-in"}`}>
          {view.name === "menu" && (
            <>
              <Section title="Projects">
                {state.projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setView({ name: "project", id: p.id })} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left">
                      <span className="size-3 shrink-0 rounded-full" style={{ background: p.color }} />
                      <span className="flex-1 text-body">{p.name}</span>
                      <span className="text-sub text-secondary">{open.filter((t) => t.project_id === p.id).length}</span>
                      <span className="text-secondary/60">{Icon.chevron}</span>
                    </button>
                  </li>
                ))}
                <NewProject onAdd={(name, color) => act("add_project", { name, color })} />
              </Section>
              <Section title="More">
                {onGo && (
                  <>
                    <li>
                      <button type="button" onClick={() => onGo("habits")} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left">
                        <span className="flex-1 text-body">🔥 Habits</span>
                        {(state.habits ?? []).some((habit) => habit.dueToday && !habit.doneToday) && <span className="rounded-full bg-done/15 px-2 py-px text-caption font-medium text-done">Today</span>}
                        <span className="text-secondary/60">{Icon.chevron}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" onClick={() => onGo("board")} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left">
                        <span className="flex-1 text-body">🗂 Plan board</span>
                        <span className="text-caption text-secondary">Today · Week · Someday</span>
                        <span className="text-secondary/60">{Icon.chevron}</span>
                      </button>
                    </li>
                  </>
                )}
                <li>
                  <button type="button" onClick={() => setView({ name: "plans" })} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left">
                    <span className="flex-1 text-body">Plans</span>
                    {state.plans.some((plan) => plan.status === "proposed") && <span className="rounded-full bg-primary/15 px-2 py-px text-caption font-medium text-primary">New</span>}
                    <span className="text-secondary/60">{Icon.chevron}</span>
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setView({ name: "settings" })} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left">
                    <span className="flex-1 text-body">Settings</span>
                    <span className="text-secondary/60">{Icon.chevron}</span>
                  </button>
                </li>
              </Section>
            </>
          )}

          {project && <ProjectTasks state={state} projectId={project.id} now={now} onOpen={onOpen} onToggle={onToggle} />}

          {view.name === "settings" && <Settings tony={tony} theme={theme} onTheme={onTheme} />}

          {view.name === "plans" && <Plans tony={tony} now={now} />}
        </div>
      </div>
    </div>
  );
}

function NewProject({ onAdd }: { onAdd: (name: string, color: string) => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  return (
    <li>
      <form
        className="flex items-center gap-2 px-3 py-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim()) return;
          await onAdd(name.trim(), color);
          setName("");
        }}
      >
        <button
          type="button"
          aria-label="Change colour"
          onClick={() => setColor(COLORS[(COLORS.indexOf(color) + 1) % COLORS.length])}
          className="grid size-11 shrink-0 place-items-center"
        >
          <span className="size-4 rounded-full" style={{ background: color }} />
        </button>
        <input className={`${field} min-w-0 flex-1`} placeholder="New project" aria-label="New project name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" disabled={!name.trim()} className="h-11 px-2 text-body font-semibold text-primary disabled:opacity-40">
          Add
        </button>
      </form>
    </li>
  );
}

function ProjectTasks(props: { state: AppState; projectId: number; now: Date; onOpen: (task: Task) => void; onToggle: (task: Task) => void }) {
  const { state, projectId, now, onOpen, onToggle } = props;
  const tasks = state.tasks.filter((t) => t.project_id === projectId && isOpen(t));
  if (tasks.length === 0) return <Empty art="project-empty">Nothing open in this project, sir.</Empty>;
  return (
    <Section title={`${tasks.length} open`}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} projects={[]} now={now} when="full" onOpen={onOpen} onToggle={onToggle} />
      ))}
    </Section>
  );
}

function Settings({ tony, theme, onTheme }: { tony: Tony; theme: Theme; onTheme: (theme: Theme) => void }) {
  const { state, act, say } = tony;
  const { settings, status } = state;
  const [schedule, setSchedule] = useState(settings.persistent_schedule.join(", "));
  // Inside Telegram the theme follows Telegram and there is nothing to sign out of.
  const inTelegram = webApp() !== undefined;

  const time = (key: "brief_morning" | "brief_evening" | "quiet_start" | "quiet_end") => (
    <input
      type="time"
      aria-label={key.replace("_", " ")}
      className={`${field} w-28`}
      defaultValue={settings[key]}
      onBlur={(event) => event.target.value && event.target.value !== settings[key] && act("settings", { [key]: event.target.value })}
    />
  );

  const saveSchedule = async () => {
    const steps = schedule.split(/[\s,]+/).filter(Boolean).map(Number);
    if (steps.join() === settings.persistent_schedule.join()) return;
    const result = await act("settings", { persistent_schedule: steps });
    if (result.ok) say("Schedule saved, sir.");
    else setSchedule(settings.persistent_schedule.join(", "));
  };

  const signOut = async () => {
    await tonyFetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  return (
    <>
      <Section title="Briefs">
        <Row label="Morning brief">{time("brief_morning")}</Row>
        <Row label="Evening review">{time("brief_evening")}</Row>
      </Section>

      <Section title="Quiet hours">
        <Row label="From">{time("quiet_start")}</Row>
        <Row label="Until" hint="No follow-up nudges in this window">
          {time("quiet_end")}
        </Row>
      </Section>

      <Section title="Persistent reminders">
        <li className="px-4 py-3">
          <label className="block text-body" htmlFor="schedule">
            Nudge after (minutes)
          </label>
          <input id="schedule" inputMode="numeric" className={`${field} mt-2 w-full`} value={schedule} onChange={(event) => setSchedule(event.target.value)} onBlur={saveSchedule} />
          <p className="mt-1.5 text-caption text-secondary">The default for persistent tasks. Then one last message, and the task waits for the morning.</p>
        </li>
      </Section>

      {(
        <Section title="Appearance">
          <li className="p-1">
            <div className="grid grid-cols-3 gap-1">
              {(["system", "light", "dark"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={theme === option}
                  onClick={() => onTheme(option)}
                  className={`h-10 rounded-[9px] text-sub font-medium capitalize ${theme === option ? "bg-background shadow-sm" : "text-secondary"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </li>
        </Section>
      )}

      <Section title="Tony's memory">
        {state.memory.length === 0 && <li className="px-4 py-3 text-sub text-secondary">Nothing remembered yet. Tell Tony a habit or preference.</li>}
        {/* This week first, then this month, then always (layered memory, 22 Nov). */}
        {state.memory
          .map((note) => normalNote(note))
          .sort((a, b) => SHOWN_ORDER.indexOf(a.layer) - SHOWN_ORDER.indexOf(b.layer) || b.id - a.id)
          .map((note) => (
            <Row key={note.id} label={note.fact} hint={[LAYER_TITLES[note.layer], note.goal ? "🎯 goal" : undefined, isAlive(note, new Date()) ? undefined : "fading"].filter(Boolean).join(" · ")}>
              <button type="button" onClick={() => act("forget", { id: note.id })} className="h-11 shrink-0 px-1 text-sub font-medium text-overdue">
                Forget
              </button>
            </Row>
          ))}
      </Section>

      <Section title="Telegram">
        {status.botUsername ? (
          <li>
            <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between px-4 py-2.5">
              <span className="text-body">@{status.botUsername}</span>
              <span className="text-sub text-primary">Open</span>
            </a>
          </li>
        ) : (
          <Row label="Bot not reachable" />
        )}
      </Section>

      <Section title="Connections">
        <Row label="Telegram bot">
          <Dot ready={status.telegram} />
        </Row>
        <Row label="Database">
          <Dot ready={status.database} />
        </Row>
        <Row label="Brain" hint={`${status.model} · voice ${status.voiceModel}`}>
          <Dot ready={status.brain} />
        </Row>
        <Row label="Reminder clock" hint={status.lastTick ? `Last tick ${formatTime(new Date(status.lastTick))}` : "No tick yet"}>
          <Dot ready={status.clock} />
        </Row>
      </Section>

      {!inTelegram && (
        <button type="button" onClick={signOut} className="mt-6 h-11 w-full rounded-card bg-surface text-body font-medium text-overdue">
          Sign out
        </button>
      )}
    </>
  );
}

const STATUS: Record<AppPlan["status"], string> = { proposed: "Proposed", applied: "Applied", dismissed: "Set aside" };

/** What Tony proposed, where he put each task, and why. */
function Plans({ tony, now }: { tony: Tony; now: Date }) {
  const { state, act, say } = tony;
  const [busy, setBusy] = useState(false);

  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy(true);
    const result = await act(action, payload);
    if (result.ok && result.reply) say(result.reply);
    setBusy(false);
  };

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" disabled={busy} onClick={() => run("plan", { scope: "day" })} className="h-11 rounded-card bg-surface text-body font-medium text-primary disabled:opacity-40">
          Plan my day
        </button>
        <button type="button" disabled={busy} onClick={() => run("plan", { scope: "week" })} className="h-11 rounded-card bg-surface text-body font-medium text-primary disabled:opacity-40">
          Plan my week
        </button>
      </div>
      {state.plans.length === 0 && <Empty art="plans">No plans yet, sir. Ask for one above, or tell me to plan your day.</Empty>}
      {state.plans.map((plan) => (
        <section key={plan.id} className="mt-6">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h2 className="text-caption font-semibold tracking-wide text-secondary uppercase">
              {plan.scope === "week" ? "Week from " : ""}
              {formatLongDate(new Date(`${plan.day}T12:00:00+05:00`)).replace(/ \d{4}$/, "")}
            </h2>
            <span className={`text-caption font-medium ${plan.status === "proposed" ? "text-primary" : plan.status === "applied" ? "text-done" : "text-secondary"}`}>{STATUS[plan.status]}</span>
          </div>
          <div className="overflow-hidden rounded-card bg-surface">
            {plan.why && (
              <p className="border-b border-hairline px-4 py-3 text-sub">
                <span className="font-semibold">Why. </span>
                {plan.why}
                {plan.planned_by === "rules" && <span className="text-secondary"> (Planned by rule; my thinking was unavailable.)</span>}
              </p>
            )}
            <ul className="divide-y divide-hairline">
              {plan.items.map((item) => (
                <li key={`${item.task_id}-${item.at}`} className="flex gap-3 px-4 py-2.5">
                  <span className="w-16 shrink-0 pt-0.5 text-sub font-medium tabular-nums">
                    {plan.scope === "week" ? formatDue(new Date(item.at), now).replace(/ \d{1,2}:\d{2}$/, "") + " " : ""}
                    {formatTime(new Date(item.at))}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-body leading-snug">{item.title}</span>
                    {item.why && <span className="block text-caption text-secondary">{item.why}</span>}
                  </span>
                </li>
              ))}
              {plan.left_out.map((item) => (
                <li key={`left-${item.task_id}`} className="flex gap-3 px-4 py-2.5 text-secondary">
                  <span className="w-16 shrink-0 pt-0.5 text-sub">Later</span>
                  <span className="min-w-0">
                    <span className="block text-body leading-snug">{item.title}</span>
                    <span className="block text-caption">{item.why}</span>
                  </span>
                </li>
              ))}
              {plan.items.length === 0 && plan.left_out.length === 0 && <li className="px-4 py-3 text-sub text-secondary">Nothing needed a slot.</li>}
            </ul>
            {plan.status === "proposed" && plan.items.length > 0 && (
              <div className="grid grid-cols-2 gap-px border-t border-hairline">
                <button type="button" disabled={busy} onClick={() => run("apply_plan", { id: plan.id })} className="h-11 text-body font-semibold text-primary disabled:opacity-40">
                  Apply
                </button>
                <button type="button" disabled={busy} onClick={() => run("dismiss_plan", { id: plan.id })} className="h-11 text-body text-secondary disabled:opacity-40">
                  Set aside
                </button>
              </div>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

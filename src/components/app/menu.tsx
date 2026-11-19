"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { AppState } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatTime } from "@/lib/time";
import { Empty, Icon, Section, TaskRow, isOpen } from "./ui";
import { pushBack, tonyFetch, webApp } from "./telegram";
import type { Tony } from "./use-tony";

type View = { name: "menu" } | { name: "project"; id: number } | { name: "settings" };
export type Theme = "system" | "light" | "dark";

const COLORS = ["#5B8BFF", "#7A5CFF", "#34C759", "#FF9F0A", "#FF5A5F", "#64748B"];
const field = "h-11 rounded-card bg-background px-3 outline-none focus:ring-2 focus:ring-primary/40";

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
}) {
  const { tony, now, theme, onTheme, onClose, onOpen, onToggle } = props;
  const { state, act } = tony;
  const [view, setView] = useState<View>({ name: "menu" });
  // Telegram's Back button: out of a sub-page first, then out of the menu.
  const inSubPage = view.name !== "menu";
  useEffect(() => pushBack(() => (inSubPage ? setView({ name: "menu" }) : onClose())), [inSubPage, onClose]);

  const open = state.tasks.filter(isOpen);
  const project = view.name === "project" ? state.projects.find((p) => p.id === view.id) : undefined;
  const heading = view.name === "settings" ? "Settings" : project ? project.name : "Tony";

  return (
    <div className="fade-in fixed inset-0 z-30 flex justify-center bg-black/40" onClick={onClose}>
      <div className="safe-top safe-bottom flex h-full w-full max-w-md flex-col bg-background" onClick={(event) => event.stopPropagation()}>
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

        <div className="flex-1 overflow-y-auto px-4 pb-8">
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
  if (tasks.length === 0) return <Empty>Nothing open in this project, sir.</Empty>;
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

      {!inTelegram && (
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
        {state.memory.map((note) => (
          <Row key={note.id} label={note.fact}>
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

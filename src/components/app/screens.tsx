"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AppState } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { splitToday } from "@/lib/today";
import { addMinutes, formatLongDate, formatTime, localDate } from "@/lib/time";
import { AddTaskRow, Empty, Icon, Section, TaskRow, formatMinutes, isOpen } from "./ui";

export type ScreenProps = {
  state: AppState;
  now: Date;
  onOpen: (task: Task) => void;
  onToggle: (task: Task) => void;
  /** Opens a new task, on a given day (YYYY-MM-DD) or in a project. */
  onAdd: (target?: { day?: string; projectId?: number }) => void;
};

/** The main column: comfortable width on a wide screen, edge to edge on a phone. */
export const PAGE = "mx-auto w-full max-w-[820px] px-4 md:px-10";
const DAY_MS = 24 * 60 * 60_000;
const TZ = "Asia/Tashkent";
const byDue = (a: Task, b: Task) => (a.due_at ?? "").localeCompare(b.due_at ?? "");
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="pt-3 md:pt-8">
      <h1 className="text-title leading-tight font-bold tracking-tight">{children}</h1>
      {sub && <p className="mt-1.5 flex items-center gap-3 text-[13px] text-secondary">{sub}</p>}
    </header>
  );
}

const attachedTo = (state: AppState) => (task: Task) => state.media.some((item) => item.task_id === task.id);
const notPrayer = (task: Task) => task.kind !== "prayer";

/** Today's five prayers as one calm strip: tap one to mark it prayed. No red, no counts. */
function PrayerStrip({ state, now, onToggle }: { state: AppState; now: Date; onToggle: (task: Task) => void }) {
  const today = localDate(now);
  const prayers = state.tasks
    .filter((t) => t.kind === "prayer" && t.due_at && localDate(new Date(t.due_at)) === today && t.status !== "skipped" && t.status !== "dropped")
    .sort(byDue);
  if (prayers.length === 0) return null;
  const next = prayers.find((t) => isOpen(t) && new Date(t.due_at!).getTime() > now.getTime());
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Prayer times today">
      <span className="mr-1 text-[13px] text-secondary">🕌</span>
      {prayers.map((task) => {
        const done = !isOpen(task);
        const upcoming = task.id === next?.id;
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onToggle(task)}
            aria-label={done ? `${task.title}, prayed. Tap to undo` : `Mark ${task.title} as prayed`}
            className={`h-7 rounded-full border px-2.5 text-[12.5px] transition-colors ${done ? "border-transparent bg-surface text-secondary" : upcoming ? "border-prayer/40 bg-prayer/10 text-prayer" : "border-hairline text-ink"}`}
          >
            {done ? "✓ " : ""}
            {task.title} <span className="text-secondary">{formatTime(new Date(task.due_at!))}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Today, as Todoist lays it out: the title, "✓ 9 tasks · ⏱ 2h 30m", a
 * collapsible Overdue section with Reschedule, then "Nov 20 · Today ·
 * Friday" with an inline Add task, and what is done today folded away.
 * The counts come from the same split as the pinned board in Telegram.
 */
export function TodayScreen(props: ScreenProps & { onQuickAdd: (text: string) => Promise<void>; onReschedule: (to: "today" | "tomorrow") => void }) {
  const { state, now, onOpen, onToggle, onAdd, onQuickAdd, onReschedule } = props;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const { carried, timed, done, total } = splitToday(state.tasks, now);
  // Overdue: everything whose time has passed (earlier days, or earlier today), unless started.
  const late = (t: Task) => t.status !== "in_progress" && new Date(t.due_at!).getTime() < now.getTime();
  const overdue = [...carried, ...timed.filter(late)].sort(byDue);
  const today = timed.filter((t) => !late(t));
  const openCount = total - done.length;
  const minutes = [...carried, ...timed].reduce((sum, t) => sum + (t.duration_minutes ?? 0), 0);
  const row = { projects: state.projects, now, onOpen, onToggle };
  const attached = attachedTo(state);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    await onQuickAdd(text);
    setSending(false);
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto pb-8">
        <div className={PAGE}>
          <Title
            sub={
              <>
                <span className="inline-flex items-center gap-1">{Icon.check}{openCount} {openCount === 1 ? "task" : "tasks"}</span>
                <span className="inline-flex items-center gap-1">{Icon.clock}{minutes ? formatMinutes(minutes) : "no durations set"}</span>
              </>
            }
          >
            Today
          </Title>
          <PrayerStrip state={state} now={now} onToggle={onToggle} />
          {overdue.length > 0 && (
            <Section
              title="Overdue"
              collapsible
              action={
                <span className="relative">
                  <button type="button" onClick={() => setRescheduling(!rescheduling)} className="h-7 rounded px-1.5 text-[13px] font-medium text-primary hover:bg-surface">
                    Reschedule
                  </button>
                  {rescheduling && (
                    <>
                      <button type="button" aria-label="Close" className="fixed inset-0 z-20 cursor-default" onClick={() => setRescheduling(false)} />
                      <span className="fade-in absolute top-8 right-0 z-30 w-48 overflow-hidden rounded-lg border border-hairline bg-background py-1 shadow-xl">
                        {(["today", "tomorrow"] as const).map((to) => (
                          <button key={to} type="button" onClick={() => (setRescheduling(false), onReschedule(to))} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[14px] text-ink hover:bg-surface">
                            <span style={{ color: to === "today" ? "var(--today)" : "var(--tomorrow)" }}>{Icon.calendar}</span>
                            All {overdue.length} to {to}
                          </button>
                        ))}
                      </span>
                    </>
                  )}
                </span>
              }
            >
              {overdue.map((task) => (
                <TaskRow key={task.id} task={task} overdue when="full" attached={attached(task)} {...row} />
              ))}
            </Section>
          )}
          <Section title={`${fmt(now, { month: "short", day: "numeric" })} · Today · ${fmt(now, { weekday: "long" })}`}>
            {today.map((task) => (
              <TaskRow key={task.id} task={task} attached={attached(task)} {...row} />
            ))}
            <AddTaskRow onAdd={() => onAdd({ day: localDate(now) })} />
          </Section>
          {done.length > 0 && (
            <Section title={`Completed · ${done.length}`} collapsible defaultOpen={false}>
              {done.map((task) => (
                <TaskRow key={task.id} task={{ ...task, status: "done" }} when="none" {...row} />
              ))}
            </Section>
          )}
          {total === 0 && <Empty>Nothing on today, sir. A rare and agreeable state of affairs.</Empty>}
        </div>
      </div>
      <form
        className="border-t border-hairline bg-background py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className={`${PAGE} flex items-center gap-2`}>
          <input
            className="h-10 min-w-0 flex-1 rounded-full bg-surface px-4 outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40"
            placeholder="Tell Tony: workout at 6 pm"
            aria-label="Quick add"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            enterKeyHint="send"
          />
          <button type="submit" aria-label="Add" disabled={!draft.trim() || sending} className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-white transition-opacity disabled:opacity-40">
            {Icon.send}
          </button>
        </div>
      </form>
    </>
  );
}

/** Undated tasks, oldest first; anything older than three days carries its age. */
export function InboxScreen({ state, now, onOpen, onToggle, onAdd, onFreeTime }: ScreenProps & { onFreeTime?: () => void }) {
  const inbox = state.tasks.filter((t) => t.status === "inbox" && !t.free_time).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const freeTime = state.tasks.filter((t) => isOpen(t) && t.free_time).length;
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title sub={inbox.length ? `${inbox.length} without a date` : undefined}>Inbox</Title>
        {onFreeTime && freeTime > 0 && (
          <button type="button" onClick={onFreeTime} className="mb-3 flex w-full items-center justify-between rounded-lg border border-hairline px-3 py-2 text-left text-[14px] hover:bg-hairline">
            <span>🌙 Free Time</span>
            <span className="text-secondary">{freeTime}</span>
          </button>
        )}
        <Section title="Oldest first">
          {inbox.map((task) => {
            const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY_MS);
            return <TaskRow key={task.id} task={task} projects={state.projects} now={now} when="none" badge={days > 3 ? `${days} days` : undefined} onOpen={onOpen} onToggle={onToggle} />;
          })}
          <AddTaskRow onAdd={() => onAdd()} />
        </Section>
      </div>
    </div>
  );
}

/** The 🌙 Free Time list (phase c): "in my free time", "someday"; no dates, the longest waiting first. */
export function FreeTimeScreen({ state, now, onOpen, onToggle }: ScreenProps) {
  const items = state.tasks.filter((t) => isOpen(t) && t.free_time).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title sub={items.length ? `${items.length} waiting for a free moment` : "Say \"in my free time…\" to add one"}>🌙 Free Time</Title>
        <Section title="Longest waiting first">
          {items.map((task) => {
            const days = Math.floor((now.getTime() - new Date(task.created_at).getTime()) / DAY_MS);
            return <TaskRow key={task.id} task={task} projects={state.projects} now={now} when="none" badge={days >= 1 ? `${days} ${days === 1 ? "day" : "days"}` : undefined} onOpen={onOpen} onToggle={onToggle} />;
          })}
        </Section>
      </div>
    </div>
  );
}

/** One project's open tasks, by date, then the undated ones. */
export function ProjectScreen({ state, now, onOpen, onToggle, onAdd, projectId }: ScreenProps & { projectId: number }) {
  const project = state.projects.find((p) => p.id === projectId);
  const tasks = state.tasks.filter((t) => isOpen(t) && t.project_id === projectId);
  const dated = tasks.filter((t) => t.due_at).sort(byDue);
  const undated = tasks.filter((t) => !t.due_at);
  const row = { projects: state.projects, now, onOpen, onToggle };
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title sub={`${tasks.length} open`}>
          <span className="inline-flex items-center gap-2">
            <span style={{ color: project?.color }}>{Icon.hash}</span>
            {project?.name ?? "Project"}
          </span>
        </Title>
        <Section title="Scheduled">
          {dated.map((task) => (
            <TaskRow key={task.id} task={task} when="full" overdue={notPrayer(task) && new Date(task.due_at!).getTime() < now.getTime()} {...row} />
          ))}
          <AddTaskRow onAdd={() => onAdd({ projectId })} />
        </Section>
        {undated.length > 0 && (
          <Section title="No date">
            {undated.map((task) => (
              <TaskRow key={task.id} task={task} when="none" {...row} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

/** Search every task Tony knows, open or recently done, by title and description. */
export function SearchScreen({ state, now, onOpen, onToggle }: ScreenProps) {
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const found = words ? state.tasks.filter((t) => `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(words)).sort(byDue) : [];
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title>Search</Title>
        <label className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-hairline px-3 text-secondary focus-within:border-primary">
          {Icon.search}
          <input autoFocus className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-secondary" placeholder="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {words && (
          <Section title={`${found.length} ${found.length === 1 ? "result" : "results"}`}>
            {found.map((task) => (
              <TaskRow key={task.id} task={task} projects={state.projects} now={now} when="full" overdue={isOpen(task) && Boolean(task.due_at) && new Date(task.due_at!).getTime() < now.getTime()} onOpen={onOpen} onToggle={onToggle} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

type Filter = { id: string; name: string; color: string; test: (task: Task, now: Date) => boolean };
const FILTERS: Filter[] = [
  { id: "p1", name: "Priority 1", color: "var(--p1)", test: (t) => t.priority === 1 },
  { id: "p2", name: "Priority 2", color: "var(--p2)", test: (t) => t.priority === 2 },
  { id: "overdue", name: "Overdue", color: "var(--overdue)", test: (t, now) => Boolean(t.due_at) && new Date(t.due_at!).getTime() < now.getTime() && t.status !== "in_progress" },
  { id: "persistent", name: "Persistent", color: "var(--accent)", test: (t) => t.persistent },
  { id: "repeating", name: "Repeating", color: "var(--primary)", test: (t) => Boolean(t.repeat_rule) },
  { id: "next7", name: "Next 7 days", color: "var(--week)", test: (t, now) => Boolean(t.due_at) && new Date(t.due_at!).getTime() >= now.getTime() && new Date(t.due_at!).getTime() < now.getTime() + 7 * DAY_MS },
  { id: "nodate", name: "No date", color: "var(--secondary)", test: (t) => !t.due_at },
];

/** Filters (and labels: Tony files by project, so the labels are the projects). */
export function FiltersScreen({ state, now, onOpen, onToggle, onProject }: ScreenProps & { onProject: (id: number) => void }) {
  const [chosen, setChosen] = useState<Filter | null>(null);
  const open = state.tasks.filter((t) => isOpen(t) && notPrayer(t));
  if (chosen) {
    const tasks = open.filter((t) => chosen.test(t, now)).sort(byDue);
    return (
      <div className="flex-1 overflow-y-auto pb-8">
        <div className={PAGE}>
          <button type="button" onClick={() => setChosen(null)} className="mt-3 h-8 text-[13px] text-primary md:mt-6">
            ‹ Filters & Labels
          </button>
          <Title sub={`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}>{chosen.name}</Title>
          <Section title="Tasks">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} projects={state.projects} now={now} when="full" overdue={Boolean(task.due_at) && new Date(task.due_at!).getTime() < now.getTime()} onOpen={onOpen} onToggle={onToggle} />
            ))}
          </Section>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title>Filters & Labels</Title>
        <Section title="My Filters">
          {FILTERS.map((filter) => (
            <li key={filter.id} className="border-b border-hairline">
              <button type="button" onClick={() => setChosen(filter)} className="flex h-11 w-full items-center gap-3 px-1 text-left text-[14px] hover:bg-surface">
                <span style={{ color: filter.color }}>{Icon.filter}</span>
                <span className="flex-1">{filter.name}</span>
                <span className="text-[12px] text-secondary">{open.filter((t) => filter.test(t, now)).length}</span>
              </button>
            </li>
          ))}
        </Section>
        <Section title="Labels">
          {state.projects.map((project) => (
            <li key={project.id} className="border-b border-hairline">
              <button type="button" onClick={() => onProject(project.id)} className="flex h-11 w-full items-center gap-3 px-1 text-left text-[14px] hover:bg-surface">
                <span style={{ color: project.color }}>{Icon.hash}</span>
                <span className="flex-1">{project.name}</span>
                <span className="text-[12px] text-secondary">{open.filter((t) => t.project_id === project.id).length}</span>
              </button>
            </li>
          ))}
        </Section>
      </div>
    </div>
  );
}

/** The next seven days. Drag a task by its grip to move it to another day. */
export function UpcomingScreen(props: ScreenProps & { onMove: (task: Task, day: string) => void; onAddTo: (day: string) => void }) {
  const { state, now, onOpen, onToggle, onMove, onAddTo } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ task: Task; x: number; y: number; over?: string } | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => {
    const at = addMinutes(now, i * 24 * 60);
    const key = localDate(at);
    const md = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tashkent", month: "short", day: "numeric" }).format(at);
    const name = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tashkent", weekday: "long" }).format(at);
    return { key, label: i === 0 ? `${md} · Today · ${name}` : i === 1 ? `${md} · Tomorrow · ${name}` : `${md} · ${name}` };
  });
  const tasksOn = (key: string) =>
    state.tasks.filter((t) => t.due_at && isOpen(t) && notPrayer(t) && localDate(new Date(t.due_at)) === key).sort(byDue);

  const dayAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest("[data-day]") as HTMLElement | null)?.dataset.day;

  const begin = (task: Task) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ task, x: event.clientX, y: event.clientY, over: localDate(new Date(task.due_at!)) });
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    // Near the top or bottom edge, scroll the list so far-off days can be reached.
    const box = scroller.current?.getBoundingClientRect();
    if (box && event.clientY < box.top + 70) scroller.current!.scrollBy(0, -14);
    if (box && event.clientY > box.bottom - 70) scroller.current!.scrollBy(0, 14);
    setDrag({ ...drag, x: event.clientX, y: event.clientY, over: dayAt(event.clientX, event.clientY) ?? drag.over });
  };
  const end = () => {
    if (!drag) return;
    const from = localDate(new Date(drag.task.due_at!));
    if (drag.over && drag.over !== from) onMove(drag.task, drag.over);
    setDrag(null);
  };

  return (
    <div ref={scroller} className={`flex-1 overflow-y-auto pb-6 ${drag ? "select-none" : ""}`}>
      <div className={PAGE}>
      <Title sub="The next seven days">Upcoming</Title>
      {days.map((day) => {
        const tasks = tasksOn(day.key);
        const target = drag?.over === day.key;
        return (
          <section key={day.key} data-day={day.key} className="mt-5">
            <div className="flex items-center border-b border-hairline pb-1.5">
              <h2 className={`flex-1 text-[14px] font-bold ${target ? "text-primary" : ""}`}>{day.label}</h2>
            </div>
            <ul className={`rounded-md transition-shadow ${target ? "ring-2 ring-primary" : ""}`}>
              {tasks.length === 0 && target && <li className="px-3 py-3 text-sub text-secondary">Drop here</li>}
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  projects={state.projects}
                  now={now}
                  onOpen={onOpen}
                  onToggle={onToggle}
                  handle={
                    <button
                      type="button"
                      aria-label={`Drag ${task.title} to another day`}
                      onPointerDown={begin(task)}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={() => setDrag(null)}
                      className={`grid w-11 shrink-0 touch-none place-items-center text-secondary/60 ${drag?.task.id === task.id ? "text-primary" : ""}`}
                    >
                      {Icon.grip}
                    </button>
                  }
                />
              ))}
              <AddTaskRow onAdd={() => onAddTo(day.key)} />
            </ul>
          </section>
        );
      })}
      </div>
      {drag && (
        <div
          className="pointer-events-none fixed z-50 max-w-[70vw] -translate-x-full -translate-y-1/2 truncate rounded-card bg-primary px-3 py-2 text-sub font-medium text-white shadow-xl"
          style={{ left: drag.x - 16, top: drag.y }}
        >
          {drag.task.title}
        </div>
      )}
    </div>
  );
}

/** The same conversation as Telegram, with a mic. */
export function ChatScreen(props: { state: AppState; onSend: (text: string) => Promise<void>; onVoice: (audio: Blob) => Promise<void> }) {
  const { state, onSend, onVoice } = props;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const count = state.messages.length;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, pending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || pending !== null) return;
    setDraft("");
    setPending(text);
    await onSend(text);
    setPending(null);
  };

  const toggleMic = async () => {
    if (recording) return recorder.current?.stop();
    setMicError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const audio = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (audio.size === 0) return;
        setPending("Voice note…");
        await onVoice(audio);
        setPending(null);
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMicError("The microphone is not available. Allow it in the browser's settings.");
    }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto pb-4">
        <div className={PAGE}>
        <Title sub="The same conversation as Telegram">Chat</Title>
        {count === 0 && pending === null && <Empty>Say something, sir. I am listening.</Empty>}
        <ol className="mt-4 space-y-2">
          {state.messages.map((message, index) => {
            const mine = message.role === "user";
            const previous = state.messages[index - 1];
            const newDay = !previous || localDate(new Date(previous.created_at)) !== localDate(new Date(message.created_at));
            return (
              <li key={message.id}>
                {newDay && <p className="my-3 text-center text-caption text-secondary">{formatLongDate(new Date(message.created_at))}</p>}
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[82%] rounded-[18px] px-3.5 py-2 ${mine ? "rounded-br-md bg-primary text-white" : "rounded-bl-md bg-surface"}`}>
                    <p className="text-body leading-snug break-words whitespace-pre-wrap">{message.text}</p>
                    <p className={`mt-0.5 text-right text-[11px] ${mine ? "text-white/70" : "text-secondary"}`}>{formatTime(new Date(message.created_at))}</p>
                  </div>
                </div>
              </li>
            );
          })}
          {pending !== null && (
            <li className="flex justify-end">
              <div className="max-w-[82%] rounded-[18px] rounded-br-md bg-primary/60 px-3.5 py-2 text-white">
                <p className="text-body leading-snug">{pending}</p>
              </div>
            </li>
          )}
          {pending !== null && (
            <li className="flex justify-start">
              <div className="rounded-[18px] rounded-bl-md bg-surface px-3.5 py-2 text-secondary">Tony is thinking…</div>
            </li>
          )}
        </ol>
        {micError && <p className="mt-3 text-center text-caption text-overdue">{micError}</p>}
        <div ref={bottom} />
        </div>
      </div>
      <form
        className="border-t border-hairline bg-background py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className={`${PAGE} flex items-center gap-2`}>
        <button
          type="button"
          onClick={toggleMic}
          aria-label={recording ? "Stop recording and send" : "Record a voice note"}
          aria-pressed={recording}
          disabled={pending !== null}
          className={`grid size-11 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40 ${recording ? "animate-pulse bg-overdue text-white" : "bg-surface text-secondary"}`}
        >
          {Icon.mic}
        </button>
        <input
          className="h-11 min-w-0 flex-1 rounded-full bg-surface px-4 outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40"
          placeholder={recording ? "Recording… tap the mic to send" : "Message Tony"}
          aria-label="Message"
          value={draft}
          disabled={recording}
          onChange={(event) => setDraft(event.target.value)}
          enterKeyHint="send"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!draft.trim() || pending !== null}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-white transition-opacity disabled:opacity-40"
        >
          {Icon.send}
        </button>
        </div>
      </form>
    </>
  );
}

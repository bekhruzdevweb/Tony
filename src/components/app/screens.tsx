"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppDayState, AppHabit, AppState } from "@/lib/app-types";
import type { Task } from "@/lib/tasks";
import { formatLongDate, formatTime, localDate } from "@/lib/time";
import { AddTaskRow, Empty, Icon, Section, TaskRow, isOpen } from "./ui";

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

const notPrayer = (task: Task) => task.kind !== "prayer";

/** Today's five prayers as one calm strip: tap one to mark it prayed. No red, no counts. */
export function PrayerStrip({ state, now, onToggle }: { state: AppState; now: Date; onToggle: (task: Task) => void }) {
  const today = localDate(now);
  const prayers = state.tasks
    .filter((t) => t.kind === "prayer" && t.due_at && localDate(new Date(t.due_at)) === today && t.status !== "skipped" && t.status !== "dropped")
    .sort(byDue);
  if (prayers.length === 0) return null;
  const next = prayers.find((t) => isOpen(t) && new Date(t.due_at!).getTime() > now.getTime());
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Prayer times today">
      <span className="mr-0.5 text-secondary [&_svg]:size-4" aria-hidden>{Icon.moon}</span>
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

/** Undated tasks, oldest first; anything older than three days carries its age. */
export function InboxScreen({ state, now, onOpen, onToggle, onAdd }: ScreenProps) {
  const inbox = state.tasks.filter((t) => t.status === "inbox").sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title sub={inbox.length ? `${inbox.length} without a date` : undefined}>Inbox</Title>
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
  { id: "p1", name: "Urgent", color: "var(--p1)", test: (t) => t.priority === 1 },
  { id: "p2", name: "Important", color: "var(--p2)", test: (t) => t.priority === 2 },
  { id: "overdue", name: "Overdue", color: "var(--overdue)", test: (t, now) => Boolean(t.due_at) && new Date(t.due_at!).getTime() < now.getTime() && t.status !== "in_progress" },
  { id: "persistent", name: "Persistent", color: "var(--accent)", test: (t) => t.persistent },
  { id: "repeating", name: "Repeating", color: "var(--primary)", test: (t) => Boolean(t.repeat_rule) },
  { id: "next7", name: "Next 7 days", color: "var(--week)", test: (t, now) => Boolean(t.due_at) && new Date(t.due_at!).getTime() >= now.getTime() && new Date(t.due_at!).getTime() < now.getTime() + 7 * DAY_MS },
  { id: "nodate", name: "No date", color: "var(--secondary)", test: (t) => !t.due_at },
];

/** Filters, and labels: his projects and his tags (#content, #ielts). */
export function FiltersScreen({ state, now, onOpen, onToggle, onProject }: ScreenProps & { onProject: (id: number) => void }) {
  const [chosen, setChosen] = useState<Filter | null>(null);
  const open = state.tasks.filter((t) => isOpen(t) && notPrayer(t));
  const tags = [...new Set(open.flatMap((t) => t.tags ?? []))].sort();
  const tagFilter = (tag: string): Filter => ({ id: `tag:${tag}`, name: `#${tag}`, color: "var(--primary)", test: (t) => (t.tags ?? []).includes(tag) });
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
        {tags.length > 0 && (
          <Section title="Tags">
            {tags.map((tag) => (
              <li key={tag} className="border-b border-hairline">
                <button type="button" onClick={() => setChosen(tagFilter(tag))} className="flex h-11 w-full items-center gap-3 px-1 text-left text-[14px] hover:bg-surface">
                  <span className="text-primary">#</span>
                  <span className="flex-1">{tag}</span>
                  <span className="text-[12px] text-secondary">{open.filter((t) => (t.tags ?? []).includes(tag)).length}</span>
                </button>
              </li>
            ))}
          </Section>
        )}
        <Section title="Projects">
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

const DAY_STYLE: Record<AppDayState, { className: string; label: string }> = {
  done: { className: "bg-done", label: "done" },
  skipped: { className: "bg-secondary/35", label: "skipped" },
  missed: { className: "border-[1.5px] border-overdue/70", label: "missed" },
  due: { className: "border-[1.5px] border-primary bg-primary/10", label: "to do today" },
  off: { className: "bg-hairline", label: "not one of its days" },
  ahead: { className: "bg-hairline", label: "ahead" },
};
const shortDayName = (day: string) => fmt(new Date(`${day}T12:00:00+05:00`), { weekday: "short", day: "numeric", month: "short" });

/** One habit: its run, its last two weeks, and today's check-in. */
function HabitCard({ habit, onCheck }: { habit: AppHabit; onCheck: (taskId: number) => void }) {
  return (
    <li className="rounded-card border border-hairline p-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{habit.title}</p>
          <p className="mt-0.5 text-[12.5px] text-secondary">
            {[habit.rule === "weekdays" ? "Weekdays" : habit.rule === "weekly" ? "Weekly" : "Daily", habit.at].filter(Boolean).join(" · ")} · best {habit.best}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[22px] leading-none font-bold tabular-nums">{habit.streak > 0 ? habit.streak : "–"}</p>
          <p className="mt-1 text-[11px] text-secondary">in a row</p>
        </div>
      </div>
      <ol className="mt-3 grid grid-cols-14 gap-1" aria-label="The last 14 days">
        {habit.recent.map((entry) => (
          <li key={entry.day} title={`${shortDayName(entry.day)}: ${DAY_STYLE[entry.state].label}`} aria-label={`${shortDayName(entry.day)}: ${DAY_STYLE[entry.state].label}`} className={`aspect-square rounded-[5px] ${DAY_STYLE[entry.state].className}`} />
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[13px] text-secondary">{habit.line.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "")}</p>
        {habit.dueToday && !habit.doneToday && (
          <button type="button" onClick={() => onCheck(habit.task_id)} className="h-9 shrink-0 rounded-full bg-done px-4 text-[13px] font-semibold text-white active:scale-95">
            ✓ Done today
          </button>
        )}
        {habit.doneToday && <span className="shrink-0 text-[13px] font-medium text-done">Done today ✓</span>}
      </div>
    </li>
  );
}

/** Habits (Phase H): each habit's run and last two weeks; then each plan's sessions this week. */
export function HabitsScreen({ state, onCheck }: { state: AppState; onCheck: (taskId: number) => void }) {
  const habits = state.habits ?? [];
  const progress = state.progress ?? [];
  const today = habits.filter((habit) => habit.dueToday || habit.doneToday);
  return (
    <div className="flex-1 overflow-y-auto pb-8">
      <div className={PAGE}>
        <Title sub={today.length ? `${today.filter((habit) => habit.doneToday).length} of ${today.length} done today` : undefined}>Habits</Title>
        {habits.length === 0 ? (
          <Empty art="habits">No habits yet. Tell Tony &ldquo;make reading a daily habit at 21:00&rdquo;, or switch on Habit on a repeating task.</Empty>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {habits.map((habit) => (
              <HabitCard key={habit.task_id} habit={habit} onCheck={onCheck} />
            ))}
          </ul>
        )}
        {progress.length > 0 && (
          <Section title="📈 Plans this week">
            {progress.map((plan) => (
              <li key={plan.name} className="border-b border-hairline px-1 py-3">
                <div className="flex items-baseline justify-between text-[14px]">
                  <span className="font-medium">{plan.name}</span>
                  <span className="text-secondary tabular-nums">
                    {plan.done}/{plan.due} done{plan.skipped ? ` · ${plan.skipped} skipped` : ""}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline">
                  <div className="h-full rounded-full bg-done" style={{ width: `${plan.due ? Math.round((plan.done / plan.due) * 100) : 0}%` }} />
                </div>
              </li>
            ))}
          </Section>
        )}
      </div>
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
        {count === 0 && pending === null && <Empty art="chat">Say something, sir. I am listening.</Empty>}
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

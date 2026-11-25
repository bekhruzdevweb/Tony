"use client";

import { useEffect, useRef, useState } from "react";
import { BIG3, big3Done, big3For } from "@/lib/big3-rules";
import { hourRange, layoutDay } from "@/lib/day-calendar";
import type { Task } from "@/lib/tasks";
import { splitToday } from "@/lib/today";
import { formatTime, localDate, minuteOfDay } from "@/lib/time";
import { shiftDay, weekStart } from "@/lib/week-rules";
import { PrayerStrip, type ScreenProps } from "./screens";
import { AddTaskRow, Empty, Icon, Section, TaskRow, formatMinutes, isOpen } from "./ui";

const TZ = "Asia/Tashkent";
const HOUR_PX = 46;
/** The hours of a day he can plan; more than 70% of it planned leaves no room for what comes up. */
const DAY_HOURS = 8;
const FULL_SHARE = 0.7;
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);
const card = "rounded-[18px] bg-background p-4 shadow-[var(--shadow-card)] ring-1 ring-hairline";

type Extra = {
  onQuickAdd: (text: string) => Promise<void>;
  /** Everything left over from earlier days moves to today, in one tap. */
  onReschedule: (to: "today" | "tomorrow") => void;
  onBig3: (action: "big3_set" | "big3_clear", payload: Record<string, unknown>) => void;
  onGoal: (action: "week_goal_done", payload: Record<string, unknown>) => void;
  onPlanner: () => void;
  onCalendar: () => void;
};

/**
 * The dashboard (Phase Q, 25 Nov, from his reference): the day at a glance. Three counters, Today's Big 3,
 * the week's outcomes, and a timeline that holds only the things with a time. Everything else is one folded
 * list: there if he wants it, never in the way.
 */
export function DashboardScreen(props: ScreenProps & Extra) {
  const { state, now, onOpen, onToggle, onAdd, onQuickAdd, onReschedule, onBig3, onGoal, onPlanner, onCalendar } = props;
  const today = localDate(now);
  const tomorrow = shiftDay(today, 1);
  const [day, setDay] = useState(today);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const { carried, timed, done, total } = splitToday(state.tasks, now);
  const openToday = [...carried, ...timed];
  const chosen = big3For(state.tasks.filter((task) => task.kind !== "prayer"), day);
  const chosenIds = new Set(big3For(state.tasks, today).map((task) => task.id));
  const rest = openToday.filter((task) => !chosenIds.has(task.id)).sort((a, b) => Number(!!a.anytime) - Number(!!b.anytime) || (a.due_at ?? "").localeCompare(b.due_at ?? ""));
  const { blocks, prayers } = layoutDay(state.tasks, today);
  const doneBlocks = done.filter((task) => !task.anytime && task.due_at);
  const focusMinutes = doneBlocks.reduce((sum, task) => sum + (task.duration_minutes ?? 0), 0);
  const plannedMinutes = blocks.reduce((sum, block) => sum + (block.task.duration_minutes ?? 0), 0);
  const tooFull = plannedMinutes > DAY_HOURS * 60 * FULL_SHARE;
  const goals = (state.weekGoals ?? []).filter((goal) => goal.week_start === weekStart(today));
  const goalsDone = goals.filter((goal) => goal.done).length;
  const areaOf = (task: Task) => state.projects.find((project) => project.id === task.project_id);
  const row = { projects: state.projects, now, onOpen, onToggle };

  // Candidates for a free slot: that day's tasks first, then the inbox; what he types narrows them.
  const candidates = state.tasks
    .filter((task) => isOpen(task) && task.kind !== "prayer" && !task.free_time && task.big3_on !== day)
    .map((task) => ({ task, onDay: Boolean(task.due_at && localDate(new Date(task.due_at)) <= day) }))
    .filter((entry) => entry.onDay || entry.task.status === "inbox")
    .filter((entry) => !filter.trim() || entry.task.title.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => Number(b.onDay) - Number(a.onDay) || b.task.id - a.task.id)
    .slice(0, 30);

  const hour = Number(fmt(now, { hour: "numeric", hour12: false })) % 24;
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

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
      <div className="flex-1 overflow-y-auto bg-surface/60 pb-8">
        <div className="mx-auto w-full max-w-[1180px] px-4 md:px-8">
          <header className="pt-3 md:pt-7">
            <h1 className="text-title leading-tight font-bold tracking-tight">{greeting}, sir</h1>
            <p className="mt-1 text-[13px] text-secondary">{fmt(now, { weekday: "long", month: "long", day: "numeric" })}</p>
          </header>
          <PrayerStrip state={state} now={now} onToggle={onToggle} />

          <div className="mt-4 grid grid-cols-3 gap-2.5 md:gap-4">
            <Counter label="Completed" value={`${done.length} / ${total}`} tone="var(--done)" />
            <Counter label="Focus time" value={focusMinutes ? formatMinutes(focusMinutes) : "0m"} tone="var(--accent)" />
            <Counter label="Planned" value={`${plannedMinutes ? formatMinutes(plannedMinutes) : "0h"} / ${DAY_HOURS}h`} tone={tooFull ? "var(--p2)" : "var(--primary)"} note={tooFull ? "Leave room for the day" : undefined} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
            <div className="min-w-0 space-y-4">
              <section className={card} aria-label="Big 3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-body font-semibold">{day === today ? "Today's Big 3" : "Tomorrow's Big 3"}</h2>
                    <p className="text-[12.5px] text-secondary">{day === today ? "Finish these and the day is a success." : "Choose them tonight, start on them tomorrow."}</p>
                  </div>
                  <div className="grid shrink-0 grid-cols-2 rounded-[10px] bg-surface p-0.5" role="tablist" aria-label="Which day">
                    {[today, tomorrow].map((option) => (
                      <button key={option} type="button" role="tab" aria-selected={day === option} onClick={() => (setDay(option), setPicking(false))} className={`h-7 rounded-[8px] px-3 text-[12.5px] font-medium ${day === option ? "bg-background shadow-sm" : "text-secondary"}`}>
                        {option === today ? "Today" : "Tomorrow"}
                      </button>
                    ))}
                  </div>
                </div>
                <ul className="mt-3 space-y-2">
                  {chosen.map((task) => {
                    const finished = big3Done(task, day, (iso) => localDate(new Date(iso)));
                    const area = areaOf(task);
                    return (
                      <li key={task.id} className="flex items-center gap-2 rounded-[12px] bg-surface py-2 pr-1 pl-2.5">
                        <button type="button" aria-label={finished ? `Done: ${task.title}` : `Mark done: ${task.title}`} disabled={finished} onClick={() => onToggle(task)} className="grid size-8 shrink-0 place-items-center">
                          <span className={`grid size-5 place-items-center rounded-full border-[1.8px] ${finished ? "border-done bg-done text-white" : ""}`} style={finished ? undefined : { borderColor: area?.color ?? "var(--primary)" }}>
                            {finished && <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
                          </span>
                        </button>
                        <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
                          <span className={`block truncate text-[15px] font-medium ${finished ? "text-secondary line-through" : "text-ink"}`}>{task.title}</span>
                          <span className="block truncate text-[12px] text-secondary">
                            {[area?.name, task.anytime || !task.due_at ? "no time" : formatTime(new Date(task.due_at)), task.duration_minutes ? formatMinutes(task.duration_minutes) : undefined].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                        <button type="button" aria-label={`Take out of the Big 3: ${task.title}`} onClick={() => onBig3("big3_clear", { id: task.id })} className="grid size-8 shrink-0 place-items-center text-[17px] text-secondary/70">×</button>
                      </li>
                    );
                  })}
                  {Array.from({ length: Math.max(0, BIG3 - chosen.length) }, (_, index) => (
                    <li key={`slot-${index}`}>
                      <button type="button" onClick={() => setPicking(!picking)} className="flex h-12 w-full items-center gap-2.5 rounded-[12px] border border-dashed border-secondary/35 pl-4 text-left text-[14px] text-secondary">
                        <span className="text-[17px] leading-none">+</span> Choose a task
                      </button>
                    </li>
                  ))}
                </ul>
                {picking && chosen.length < BIG3 && (
                  <div className="fade-in mt-3 rounded-[12px] bg-surface p-2">
                    <input autoFocus className="h-9 w-full rounded-[9px] bg-background px-3 text-[14px] outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40" placeholder="Find a task" aria-label="Find a task" value={filter} onChange={(event) => setFilter(event.target.value)} />
                    <ul className="mt-1.5 max-h-56 overflow-y-auto">
                      {candidates.map(({ task, onDay }) => (
                        <li key={task.id}>
                          <button type="button" onClick={() => (onBig3("big3_set", { id: task.id, day }), setFilter(""), chosen.length + 1 >= BIG3 && setPicking(false))} className="flex min-h-10 w-full items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-[14px] hover:bg-background">
                            <span className="size-2 shrink-0 rounded-full" style={{ background: areaOf(task)?.color ?? "var(--p4)" }} />
                            <span className="min-w-0 flex-1 truncate">{task.title}</span>
                            <span className="shrink-0 text-[11.5px] text-secondary">{onDay ? (day === today ? "today" : "that day") : "inbox"}</span>
                          </button>
                        </li>
                      ))}
                      {candidates.length === 0 && <li className="px-2.5 py-2 text-[13px] text-secondary">Nothing matches. Add the task first, then choose it.</li>}
                    </ul>
                  </div>
                )}
              </section>

              <section className={card} aria-label="This week's outcomes">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-body font-semibold">Weekly goals</h2>
                    <p className="text-[12.5px] text-secondary">This week&apos;s outcomes.</p>
                  </div>
                  <button type="button" onClick={onPlanner} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">Plan week →</button>
                </div>
                {goals.length > 0 ? (
                  <>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface">
                        <div className="h-full rounded-full bg-done transition-[width] duration-500" style={{ width: `${(goalsDone / goals.length) * 100}%` }} />
                      </div>
                      <span className="text-[12.5px] font-medium text-secondary">{goalsDone} of {goals.length}</span>
                    </div>
                    <ul className="mt-2">
                      {goals.map((goal) => (
                        <li key={goal.id}>
                          <button type="button" onClick={() => onGoal("week_goal_done", { id: goal.id, done: !goal.done })} className="flex min-h-9 w-full items-center gap-2.5 py-1 text-left">
                            <span className={`grid size-[18px] shrink-0 place-items-center rounded-[6px] border-[1.6px] ${goal.done ? "border-done bg-done text-white" : "border-secondary/50"}`}>
                              {goal.done && <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
                            </span>
                            <span className={`text-[14.5px] ${goal.done ? "text-secondary line-through" : "text-ink"}`}>{goal.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-3 text-[13.5px] text-secondary">No outcomes chosen for this week yet. Three to five is plenty.</p>
                )}
              </section>

              <section className={`${card} pt-1`} aria-label="Everything else today">
                <Section
                  title={`Everything else · ${rest.length}`}
                  collapsible
                  defaultOpen={rest.length <= 4}
                  action={
                    carried.length > 0 ? (
                      <button type="button" onClick={() => onReschedule("today")} className="h-7 rounded-full px-2.5 text-[12.5px] font-medium text-primary hover:bg-surface">
                        Move {carried.length} from earlier days to today
                      </button>
                    ) : undefined
                  }
                >
                  {rest.map((task) => (
                    <TaskRow key={task.id} task={task} attached={state.media.some((item) => item.task_id === task.id)} {...row} />
                  ))}
                  <AddTaskRow onAdd={() => onAdd({ day: today })} />
                </Section>
                {done.length > 0 && (
                  <Section title={`Completed · ${done.length}`} collapsible defaultOpen={false}>
                    {done.map((task) => (
                      <TaskRow key={task.id} task={{ ...task, status: "done" }} when="none" {...row} />
                    ))}
                  </Section>
                )}
              </section>
            </div>

            <div className="min-w-0 space-y-4">
              <section className={card} aria-label="Daily timeline">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-body font-semibold">Daily timeline</h2>
                    <p className="text-[12.5px] text-secondary">Only what has a time.</p>
                  </div>
                  <button type="button" onClick={onCalendar} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">Calendar →</button>
                </div>
                {blocks.length > 0 ? (
                  <Timeline blocks={blocks} prayers={prayers} now={now} colorOf={(task) => areaOf(task)?.color ?? "var(--primary)"} onOpen={onOpen} />
                ) : (
                  <Empty art="today-clear">No time blocks today. Give a big task a time and a length and it appears here.</Empty>
                )}
              </section>
              <FocusTimer tasks={big3For(state.tasks, today).filter(isOpen)} />
            </div>
          </div>
        </div>
      </div>
      <form
        className="border-t border-hairline bg-background py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mx-auto flex w-full max-w-[820px] items-center gap-2 px-4">
          <input className="h-10 min-w-0 flex-1 rounded-full bg-surface px-4 outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40" placeholder="Tell Tony: IELTS reading at 9 for 90 minutes" aria-label="Quick add" value={draft} onChange={(event) => setDraft(event.target.value)} enterKeyHint="send" />
          <button type="submit" aria-label="Add" disabled={!draft.trim() || sending} className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-white transition-opacity disabled:opacity-40">
            {Icon.send}
          </button>
        </div>
      </form>
    </>
  );
}

function Counter({ label, value, tone, note }: { label: string; value: string; tone: string; note?: string }) {
  return (
    <div className="rounded-[16px] bg-background px-3 py-2.5 shadow-[var(--shadow-card)] ring-1 ring-hairline md:px-4 md:py-3.5">
      <p className="text-[12px] font-medium text-secondary md:text-[13px]">{label}</p>
      <p className="mt-0.5 text-[19px] leading-tight font-bold tracking-tight md:text-[26px]" style={{ color: tone }}>{value}</p>
      {note && <p className="mt-0.5 text-[11px] text-secondary">{note}</p>}
    </div>
  );
}

/** The day's time blocks on an hour grid: each as tall as its length, in its area's colour; a line marks now. */
function Timeline({ blocks, prayers, now, colorOf, onOpen }: { blocks: ReturnType<typeof layoutDay>["blocks"]; prayers: Task[]; now: Date; colorOf: (task: Task) => string; onOpen: (task: Task) => void }) {
  const nowMinute = minuteOfDay(now);
  // From an hour before the first block (or now) to an hour after the last: a short, readable day.
  const wide = hourRange(blocks, prayers);
  const first = Math.min(...blocks.map((block) => block.start), nowMinute);
  const last = Math.max(...blocks.map((block) => block.start + block.minutes), nowMinute);
  const from = Math.max(wide.from > 7 ? 7 : wide.from, Math.floor(first / 60) - 1, 0);
  const to = Math.min(24, Math.ceil(last / 60) + 1);
  const hours = Array.from({ length: to - from }, (_, index) => from + index);
  const top = (minute: number) => ((minute - from * 60) / 60) * HOUR_PX;
  return (
    <div className="relative mt-3 ml-12" style={{ height: hours.length * HOUR_PX + 12 }}>
      {hours.map((hour) => (
        <div key={hour} className="absolute inset-x-0 border-t border-hairline" style={{ top: top(hour * 60) + 6 }}>
          <span className="absolute -top-2 -left-12 w-10 text-right text-[11px] text-secondary">{String(hour).padStart(2, "0")}:00</span>
        </div>
      ))}
      {blocks.map(({ task, start, minutes, column, columns }) => {
        const open = isOpen(task);
        const color = colorOf(task);
        const height = Math.max((minutes / 60) * HOUR_PX - 3, 24);
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpen(task)}
            className="absolute overflow-hidden rounded-[10px] px-2.5 py-1 text-left"
            style={{ top: top(start) + 7, height, left: `calc(${(column / columns) * 100}% + 1px)`, width: `calc(${100 / columns}% - 3px)`, background: `color-mix(in srgb, ${color} ${open ? 16 : 7}%, var(--background))`, borderLeft: `3px solid ${open ? color : "var(--p4)"}` }}
          >
            <span className={`block truncate text-[13px] leading-tight font-medium ${open ? "text-ink" : "text-secondary line-through"}`}>{task.title}</span>
            {height >= 38 && <span className="block truncate text-[11px] text-secondary">{formatTime(new Date(task.due_at!))}{task.duration_minutes ? ` · ${formatMinutes(task.duration_minutes)}` : ""}</span>}
          </button>
        );
      })}
      {nowMinute >= from * 60 && nowMinute <= to * 60 && (
        <div className="pointer-events-none absolute inset-x-0 z-10 border-t-[1.5px] border-overdue" style={{ top: top(nowMinute) + 6 }}>
          <span className="absolute -top-[4.5px] -left-1 size-2 rounded-full bg-overdue" />
        </div>
      )}
    </div>
  );
}

const FOCUS_MINUTES = 25;
const BREAK_MINUTES = 5;

/** A plain focus timer for a block of deep work: 25 minutes on, 5 off. It lives on this screen only. */
function FocusTimer({ tasks }: { tasks: Task[] }) {
  const [mode, setMode] = useState<"focus" | "break">("focus");
  const [left, setLeft] = useState(FOCUS_MINUTES * 60);
  const [running, setRunning] = useState(false);
  const [on, setOn] = useState<number | null>(null);
  const endsAt = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    endsAt.current = Date.now() + left * 1000;
    const beat = setInterval(() => {
      const seconds = Math.max(0, Math.round(((endsAt.current ?? Date.now()) - Date.now()) / 1000));
      setLeft(seconds);
      if (seconds === 0) {
        setRunning(false);
        const next = mode === "focus" ? "break" : "focus";
        setMode(next);
        setLeft((next === "focus" ? FOCUS_MINUTES : BREAK_MINUTES) * 60);
      }
    }, 500);
    return () => clearInterval(beat);
    // The countdown restarts only when it is started or its mode changes, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, mode]);

  const total = (mode === "focus" ? FOCUS_MINUTES : BREAK_MINUTES) * 60;
  const share = 1 - left / total;
  const clock = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  const reset = () => (setRunning(false), setMode("focus"), setLeft(FOCUS_MINUTES * 60));
  const R = 52;
  const C = 2 * Math.PI * R;

  return (
    <section className={card} aria-label="Focus timer">
      <h2 className="text-body font-semibold">Focus</h2>
      <p className="text-[12.5px] text-secondary">{mode === "focus" ? "25 minutes on one thing." : "A 5 minute break."}</p>
      <div className="mt-3 flex items-center gap-4">
        <div className="relative grid size-[124px] shrink-0 place-items-center">
          <svg viewBox="0 0 124 124" className="absolute inset-0 -rotate-90">
            <circle cx="62" cy="62" r={R} fill="none" stroke="var(--surface)" strokeWidth="8" />
            <circle cx="62" cy="62" r={R} fill="none" stroke={mode === "focus" ? "var(--primary)" : "var(--done)"} strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - share)} className="transition-[stroke-dashoffset] duration-500" />
          </svg>
          <span className="text-[24px] font-bold tracking-tight tabular-nums">{clock}</span>
        </div>
        <div className="min-w-0 flex-1">
          {tasks.length > 0 && (
            <ul className="mb-2 space-y-0.5">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button type="button" aria-pressed={on === task.id} onClick={() => setOn(on === task.id ? null : task.id)} className={`w-full truncate rounded-[8px] px-2 py-1 text-left text-[13px] ${on === task.id ? "bg-primary/10 font-medium text-primary" : "text-secondary"}`}>
                    {task.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setRunning(!running)} className="h-9 rounded-full bg-primary px-5 text-[14px] font-semibold text-white">
              {running ? "Pause" : left < total ? "Resume" : "Start"}
            </button>
            <button type="button" onClick={reset} className="h-9 rounded-full px-3 text-[14px] text-secondary hover:bg-surface">Reset</button>
          </div>
        </div>
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { BIG3, big3Done, big3For } from "@/lib/big3-rules";
import { staysPut } from "@/lib/stays-put";
import { layoutDay } from "@/lib/day-calendar";
import type { Task } from "@/lib/tasks";
import { splitToday } from "@/lib/today";
import { formatTime, localDate, minuteOfDay } from "@/lib/time";
import { MAX_WEEK_GOALS, shiftDay, weekStart } from "@/lib/week-rules";
import { clockOf, inkOn } from "./block-style";
import { type ScreenProps } from "./screens";
import { AddTaskRow, Empty, Icon, TaskRow, formatMinutes, isOpen } from "./ui";

const TZ = "Asia/Tashkent";
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);
/** The one task list, by how much each matters: urgent first, the small things last. */
const PRIORITY_GROUPS = [
  { name: "Urgent", color: "var(--p1)", levels: [1] },
  { name: "Important", color: "var(--p2)", levels: [2] },
  { name: "Small tasks", color: "var(--p4)", levels: [3, 4] },
];
const card = "rounded-[18px] bg-background p-4 shadow-[var(--shadow-card)] ring-1 ring-hairline";

type Extra = {
  onQuickAdd: (text: string) => Promise<void>;
  /** Everything left over from earlier days moves to today, in one tap. */
  onReschedule: (to: "today" | "tomorrow") => void;
  onBig3: (action: "big3_set" | "big3_clear", payload: Record<string, unknown>) => void;
  onGoal: (action: "week_goal_add" | "week_goal_done" | "week_goal_remove", payload: Record<string, unknown>) => void;
  onSkip: (task: Task) => void;
  onCalendar: () => void;
};

/**
 * The dashboard (27 Nov, his rework): the week's goals on top, then every open task in one list ordered by
 * priority (nothing hidden, so nothing is missed), then what is overdue at the bottom. The timeline holds
 * only the things with a time.
 */
export function DashboardScreen(props: ScreenProps & Extra) {
  const { state, now, onOpen, onToggle, onAdd, onQuickAdd, onReschedule, onBig3, onGoal, onSkip, onCalendar } = props;
  const today = localDate(now);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const tomorrow = shiftDay(today, 1);
  const [day, setDay] = useState(today);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");

  const { carried: late, timed } = splitToday(state.tasks, now);
  // A missed workout is not overdue: it stays on its day, not done, and nothing carries it forward.
  const carried = late.filter((task) => !staysPut(task));
  const missed = late.filter(staysPut);
  const { blocks } = layoutDay(state.tasks, today);
  // Today's open tasks, except what is overdue (its own list below) and what lives elsewhere (prayers, habits).
  const overdueIds = new Set(late.map((task) => task.id));
  // The list holds today's tasks only; the rest of the days are in the Inbox and the calendar.
  const open = timed.filter((task) => task.kind !== "prayer" && !task.habit && !overdueIds.has(task.id));
  const chosen = big3For(state.tasks.filter((task) => task.kind !== "prayer"), day);
  const candidates = state.tasks
    .filter((task) => isOpen(task) && task.kind !== "prayer" && task.big3_on !== day)
    .map((task) => ({ task, onDay: Boolean(task.due_at && localDate(new Date(task.due_at)) <= day) }))
    .filter((entry) => entry.onDay || entry.task.status === "inbox")
    .filter((entry) => !filter.trim() || entry.task.title.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => Number(b.onDay) - Number(a.onDay) || b.task.id - a.task.id)
    .slice(0, 30);
  const byWhen = (a: Task, b: Task) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9") || a.id - b.id;
  const groups = PRIORITY_GROUPS.map((group) => ({ ...group, tasks: open.filter((task) => group.levels.includes(task.priority)).sort(byWhen) })).filter((group) => group.tasks.length > 0);
  const goals = (state.weekGoals ?? []).filter((goal) => goal.week_start === weekStart(today));
  const goalsDone = goals.filter((goal) => goal.done).length;
  const areaOf = (task: Task) => state.projects.find((project) => project.id === task.project_id);
  const row = { projects: state.projects, now, onOpen, onToggle };
  // The focus timer offers the urgent and important tasks that are still open.
  const focusTasks = [...open].filter((task) => task.priority <= 2).sort(byWhen).slice(0, 4);

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

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
            <div className="min-w-0 space-y-4">
              <section className={card} aria-label="This week's goals">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-body font-semibold">Weekly goals</h2>
                    <p className="text-[12.5px] text-secondary">{goals.length ? "What this week is for." : "Choose up to five outcomes for the week."}</p>
                  </div>
                  {goals.length > 0 && <span className="text-[12.5px] font-medium text-secondary">{goalsDone} of {goals.length}</span>}
                </div>
                {goals.length > 0 && (
                  <>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface">
                      <div className="h-full rounded-full bg-done transition-[width] duration-500" style={{ width: `${(goalsDone / goals.length) * 100}%` }} />
                    </div>
                    <ul className="mt-2">
                      {goals.map((goal) => (
                        <li key={goal.id} className="group flex items-center">
                          <button type="button" onClick={() => onGoal("week_goal_done", { id: goal.id, done: !goal.done })} className="flex min-h-10 min-w-0 flex-1 items-center gap-3 py-1 text-left">
                            <span className={`grid size-[22px] shrink-0 place-items-center rounded-full border-[1.8px] ${goal.done ? "border-done bg-done text-white" : "border-secondary/50"}`}>
                              {goal.done && <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
                            </span>
                            <span className={`min-w-0 text-[15.5px] leading-snug font-medium ${goal.done ? "text-secondary line-through" : "text-ink"}`}>{goal.title}</span>
                          </button>
                          <button type="button" aria-label={`Remove goal: ${goal.title}`} onClick={() => onGoal("week_goal_remove", { id: goal.id })} className="grid size-8 shrink-0 place-items-center rounded-full text-[17px] text-secondary/60 opacity-100 hover:bg-surface md:opacity-0 md:group-hover:opacity-100">×</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {goals.length < MAX_WEEK_GOALS && (
                  <form
                    className="mt-2 flex items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const title = goalDraft.trim();
                      if (!title) return;
                      onGoal("week_goal_add", { title });
                      setGoalDraft("");
                    }}
                  >
                    <input className="h-10 min-w-0 flex-1 rounded-[11px] bg-surface px-3 text-[14.5px] outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40" placeholder="Add a goal for this week" aria-label="Add a goal for this week" value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} />
                    <button type="submit" disabled={!goalDraft.trim()} className="h-10 rounded-[11px] px-3 text-[14px] font-semibold text-primary disabled:opacity-40">Add</button>
                  </form>
                )}
              </section>

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

              <section className={card} aria-label="Tasks">
                <div>
                  <h2 className="text-body font-semibold">Tasks today <span className="font-normal text-secondary">· {open.length}</span></h2>
                  <p className="text-[12.5px] text-secondary">Today only, the most important first.</p>
                </div>
                {groups.map((group) => (
                  <div key={group.name} className="mt-3">
                    <h3 className="flex items-center gap-2 border-b border-hairline pb-1.5 text-[12.5px] font-semibold text-secondary">
                      <span className="size-2.5 rounded-full" style={{ background: group.color }} />
                      {group.name}
                      <span className="font-normal">{group.tasks.length}</span>
                    </h3>
                    <ul className="list-none">
                      {group.tasks.map((task) => (
                        <TaskRow key={task.id} task={task} when="full" attached={state.media.some((item) => item.task_id === task.id)} {...row} />
                      ))}
                    </ul>
                  </div>
                ))}
                {groups.length === 0 && <p className="mt-3 text-[13.5px] text-secondary">Nothing left for today.</p>}
                <ul className="list-none">
                  <AddTaskRow onAdd={() => onAdd({ day: today })} />
                </ul>
              </section>

              {missed.length > 0 && (
                <section className={card} aria-label="Missed">
                  <div>
                    <h2 className="text-body font-semibold">Missed <span className="font-normal text-secondary">· {missed.length}</span></h2>
                    <p className="text-[12.5px] text-secondary">Not done, and left on their own day. Skip one, or move it yourself.</p>
                  </div>
                  <ul className="mt-1 list-none">
                    {missed.map((task) => (
                      <TaskRow key={task.id} task={task} when="full" attached={state.media.some((item) => item.task_id === task.id)} {...row} below={<button type="button" onClick={() => onSkip(task)} className="mb-2 ml-10 h-7 rounded-full bg-surface px-3 text-[12.5px] font-medium text-secondary hover:text-ink md:ml-9">Skip this one</button>} />
                    ))}
                  </ul>
                </section>
              )}

              {carried.length > 0 && (
                <section className={card} aria-label="Overdue">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-body font-semibold text-overdue">Overdue <span className="font-normal">· {carried.length}</span></h2>
                      <p className="text-[12.5px] text-secondary">Left over from earlier days.</p>
                    </div>
                    <button type="button" onClick={() => onReschedule("today")} className="h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium text-primary hover:bg-surface">Bring all to today</button>
                  </div>
                  <ul className="mt-1 list-none">
                    {carried.map((task) => (
                      <TaskRow key={task.id} task={task} when="full" overdue attached={state.media.some((item) => item.task_id === task.id)} {...row} />
                    ))}
                  </ul>
                </section>
              )}

            </div>

            <div className="min-w-0 space-y-4">
              <section className={card} aria-label="Daily timeline">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-body font-semibold">Daily timeline</h2>
                    <p className="text-[12.5px] text-secondary">Your time blocks, hour by hour.</p>
                  </div>
                  <button type="button" onClick={onCalendar} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">Calendar →</button>
                </div>
                {blocks.length > 0 ? (
                  <Timeline blocks={blocks} now={now} colorOf={(task) => areaOf(task)?.color ?? "#007AFF"} onOpen={onOpen} />
                ) : (
                  <Empty art="today-clear">No time blocks today. Give a big task a time and a length and it appears here.</Empty>
                )}
              </section>
              <FocusTimer tasks={[...big3For(state.tasks, today).filter(isOpen), ...focusTasks.filter((task) => !big3For(state.tasks, today).some((chosenTask) => chosenTask.id === task.id))].slice(0, 4)} />
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

const HOUR_PX = 60;

/**
 * Time blocking as he drew it (25 Nov, his reference): the hours down the left with a line at each, an axis,
 * and each block a bold solid slab of its area's colour, exactly as tall as its length, with its hours in the
 * corner and its name large in the middle. Blocks that follow each other touch. A red line marks now.
 */
function Timeline({ blocks, now, colorOf, onOpen }: { blocks: ReturnType<typeof layoutDay>["blocks"]; now: Date; colorOf: (task: Task) => string; onOpen: (task: Task) => void }) {
  const nowMinute = minuteOfDay(now);
  const from = Math.floor(Math.min(...blocks.map((block) => block.start)) / 60);
  const to = Math.min(24, Math.ceil(Math.max(...blocks.map((block) => block.start + block.minutes)) / 60));
  const hours = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const top = (minute: number) => ((minute - from * 60) / 60) * HOUR_PX;
  const PAD = 10;
  return (
    <div className="relative mt-4" style={{ height: (to - from) * HOUR_PX + PAD * 2 }}>
      {hours.map((hour) => (
        <div key={hour} className="absolute inset-x-0 flex items-center" style={{ top: top(hour * 60) + PAD - 8, height: 16 }}>
          <span className="w-12 shrink-0 text-[12px] font-medium text-secondary tabular-nums">{String(hour % 24).padStart(2, "0")}:00</span>
          <span className="h-px flex-1 bg-ink/15" />
        </div>
      ))}
      {/* The axis the blocks hang from. */}
      <span className="absolute w-px bg-ink/25" style={{ left: 64, top: 0, bottom: 0 }} />
      <div className="absolute" style={{ left: 76, right: 6, top: PAD, bottom: PAD }}>
        {blocks.map(({ task, start, minutes, column, columns }) => {
          const open = isOpen(task);
          const color = open ? colorOf(task) : "#d1d1d6";
          const ink = open ? inkOn(color) : "#6e6e73";
          const height = Math.max((minutes / 60) * HOUR_PX - 2, 26);
          const roomy = height >= 62;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onOpen(task)}
              className="absolute flex flex-col overflow-hidden rounded-[14px] px-3 text-left"
              style={{ top: top(start) + 1, height, left: `calc(${(column / columns) * 100}% + 1px)`, width: `calc(${100 / columns}% - 2px)`, background: color, color: ink, paddingTop: roomy ? 7 : 0, paddingBottom: roomy ? 7 : 0, justifyContent: roomy ? "flex-start" : "center" }}
            >
              {roomy ? (
                <>
                  <span className="text-[11.5px] leading-none font-medium tabular-nums opacity-80">{clockOf(start)} – {clockOf(start + minutes)}</span>
                  <span className={`flex min-h-0 flex-1 items-center justify-center text-center leading-tight font-bold tracking-tight ${open ? "" : "line-through"} ${columns > 1 ? "text-[14px]" : height >= 110 ? "text-[20px]" : "text-[16.5px]"}`}>
                    <span className="line-clamp-2">{task.title}</span>
                  </span>
                </>
              ) : (
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[11px] font-medium tabular-nums opacity-80">{clockOf(start)} – {clockOf(start + minutes)}</span>
                  <span className={`min-w-0 truncate text-[14px] font-bold tracking-tight ${open ? "" : "line-through"}`}>{task.title}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      {nowMinute >= from * 60 && nowMinute <= to * 60 && (
        <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: top(nowMinute) + PAD - 5, height: 10 }} aria-label={`Now, ${clockOf(nowMinute)}`}>
          <span className="w-12 shrink-0" />
          <span className="-ml-0.5 size-2.5 shrink-0 rounded-full bg-overdue ring-2 ring-background" style={{ marginLeft: 11 }} />
          <span className="h-[2px] flex-1 rounded-full bg-overdue" />
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

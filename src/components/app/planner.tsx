"use client";

import { useState } from "react";
import type { Task } from "@/lib/tasks";
import { localDate } from "@/lib/time";
import { MAX_WEEK_GOALS, planningWeek, shiftDay, weekStart } from "@/lib/week-rules";
import { WeekCalendar } from "./calendar";
import type { ScreenProps } from "./screens";
import { Icon } from "./ui";

const TZ = "Asia/Tashkent";
const noon = (day: string) => new Date(`${day}T12:00:00+05:00`);
const fmt = (day: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(noon(day));

/**
 * The weekly planner (Phase P, 25 Nov: "a separate page with my AI to do a weekly plan … the calendar,
 * my priorities and everything"). Three parts on one page: the week's outcomes (three to five), what is
 * still waiting in the inbox by life area, and the week itself. He places a task with two taps; Tony is
 * one line away at the bottom. Nothing is placed for him.
 */
export function PlannerScreen(props: ScreenProps & { onGoal: (action: "week_goal_add" | "week_goal_done" | "week_goal_remove", payload: Record<string, unknown>) => void; onPlace: (task: Task, day: string) => void; onTell: (text: string) => Promise<void> }) {
  const { state, now, onOpen, onToggle, onAdd, onGoal, onPlace, onTell } = props;
  const today = localDate(now);
  const thisWeek = weekStart(today);
  const [week, setWeek] = useState(() => planningWeek(today));
  const [draft, setDraft] = useState("");
  const [placing, setPlacing] = useState<number | null>(null);
  const [say, setSay] = useState("");
  const [sending, setSending] = useState(false);
  const days = Array.from({ length: 7 }, (_, index) => shiftDay(week, index));
  const goals = (state.weekGoals ?? []).filter((goal) => goal.week_start === week);
  const waiting = state.tasks.filter((task) => task.status === "inbox" && !task.free_time && task.kind !== "prayer");
  const areas = [...state.projects.filter((project) => waiting.some((task) => task.project_id === project.id)).map((project) => ({ id: project.id as number | null, name: project.name, color: project.color })), { id: null, name: "No area", color: "var(--p4)" }]
    .map((area) => ({ ...area, tasks: waiting.filter((task) => (task.project_id ?? null) === area.id) }))
    .filter((area) => area.tasks.length > 0);
  const colorOf = (projectId: number | null) => state.projects.find((project) => project.id === projectId)?.color ?? "var(--p4)";

  const addGoal = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    onGoal("week_goal_add", { title, week });
  };
  const tell = async () => {
    const text = say.trim();
    if (!text || sending) return;
    setSending(true);
    setSay("");
    await onTell(text);
    setSending(false);
  };

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pt-2 pb-3 md:px-8 md:pt-6">
        <div>
          <h1 className="text-title leading-tight font-bold tracking-tight">Weekly planner</h1>
          <p className="mt-0.5 text-[13px] text-secondary">
            {fmt(week, { month: "short", day: "numeric" })} – {fmt(days[6], { month: "short", day: "numeric" })}
          </p>
        </div>
        <div className="grid grid-cols-2 rounded-[10px] bg-surface p-0.5" role="tablist" aria-label="Which week">
          {[thisWeek, shiftDay(thisWeek, 7)].map((monday, index) => (
            <button key={monday} type="button" role="tab" aria-selected={week === monday} onClick={() => setWeek(monday)} className={`h-8 rounded-[8px] px-4 text-[13px] font-medium ${week === monday ? "bg-background shadow-sm" : "text-secondary"}`}>
              {index === 0 ? "This week" : "Next week"}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <aside className="shrink-0 space-y-4 px-4 pb-4 md:px-8 lg:w-[340px] lg:overflow-y-auto lg:pr-3" aria-label="Outcomes and waiting tasks">
          <section className="rounded-card bg-surface p-3.5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold">Outcomes</h2>
              <span className="text-[12px] text-secondary">{goals.length} of {MAX_WEEK_GOALS}</span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-secondary">Three to five things that make this week a success.</p>
            <ul className="mt-2 space-y-1">
              {goals.map((goal) => (
                <li key={goal.id} className="flex items-center gap-2 rounded-[10px] bg-background py-1.5 pr-1 pl-2.5">
                  <button type="button" aria-label={goal.done ? `Not done: ${goal.title}` : `Done: ${goal.title}`} onClick={() => onGoal("week_goal_done", { id: goal.id, done: !goal.done })} className="grid size-7 shrink-0 place-items-center">
                    <span className={`grid size-[18px] place-items-center rounded-full border-[1.6px] ${goal.done ? "border-done bg-done text-white" : ""}`} style={goal.done ? undefined : { borderColor: colorOf(goal.project_id) }}>
                      {goal.done && <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
                    </span>
                  </button>
                  <span className={`min-w-0 flex-1 text-[14px] leading-snug ${goal.done ? "text-secondary line-through" : "text-ink"}`}>{goal.title}</span>
                  <button type="button" aria-label={`Remove: ${goal.title}`} onClick={() => onGoal("week_goal_remove", { id: goal.id })} className="grid size-7 shrink-0 place-items-center text-[16px] text-secondary/70">×</button>
                </li>
              ))}
            </ul>
            {goals.length < MAX_WEEK_GOALS ? (
              <form
                className="mt-2 flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  addGoal();
                }}
              >
                <input className="h-9 min-w-0 flex-1 rounded-[10px] bg-background px-3 text-[14px] outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40" placeholder="Add an outcome" aria-label="Add an outcome" value={draft} onChange={(event) => setDraft(event.target.value)} enterKeyHint="done" />
                <button type="submit" disabled={!draft.trim()} className="h-9 rounded-[10px] px-3 text-[14px] font-semibold text-primary disabled:opacity-40">Add</button>
              </form>
            ) : (
              <p className="mt-2 text-[12.5px] text-secondary">Five is the limit: remove one to add another.</p>
            )}
          </section>

          <section>
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-body font-semibold">Waiting in the inbox</h2>
              <span className="text-[12px] text-secondary">{waiting.length}</span>
            </div>
            <p className="mt-0.5 px-1 text-[12.5px] text-secondary">Tap a task, then the day it belongs to.</p>
            {areas.map((area) => (
              <div key={area.id ?? "none"} className="mt-3">
                <p className="flex items-center gap-1.5 px-1 text-[12px] font-medium tracking-wide text-secondary uppercase">
                  <span className="size-2 rounded-full" style={{ background: area.color }} />
                  {area.name} · {area.tasks.length}
                </p>
                <ul className="mt-1 space-y-1">
                  {area.tasks.map((task) => (
                    <li key={task.id} className="rounded-[10px] bg-surface">
                      <div className="flex items-center">
                        <button type="button" aria-expanded={placing === task.id} onClick={() => setPlacing(placing === task.id ? null : task.id)} className="min-w-0 flex-1 py-2 pr-1 pl-3 text-left text-[14px] leading-snug">
                          {task.title}
                        </button>
                        <button type="button" aria-label={`Open: ${task.title}`} onClick={() => onOpen(task)} className="grid size-9 shrink-0 place-items-center text-secondary/70">
                          {Icon.chevron}
                        </button>
                      </div>
                      {placing === task.id && (
                        <div className="fade-in grid grid-cols-7 gap-1 px-2 pb-2">
                          {days.map((day) => (
                            <button key={day} type="button" disabled={day < today} onClick={() => (setPlacing(null), onPlace(task, day))} className={`flex flex-col items-center rounded-[9px] py-1 text-[11px] disabled:opacity-30 ${day === today ? "bg-primary text-white" : "bg-background text-ink"}`}>
                              <span className={day === today ? "text-white/80" : "text-secondary"}>{fmt(day, { weekday: "short" })}</span>
                              <span className="text-[14px] font-semibold">{Number(day.slice(8))}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {waiting.length === 0 && <p className="mt-3 px-1 text-[13px] text-secondary">Nothing is waiting, sir.</p>}
          </section>
        </aside>

        <div className="flex h-[70dvh] min-w-0 shrink-0 flex-col lg:h-auto lg:flex-1 lg:shrink">
          <WeekCalendar state={state} now={now} onOpen={onOpen} onToggle={onToggle} onAdd={onAdd} week={week} />
        </div>
      </div>

      <form
        className="shrink-0 border-t border-hairline bg-background py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void tell();
        }}
      >
        <div className="mx-auto flex w-full max-w-[820px] items-center gap-2 px-4">
          <input className="h-10 min-w-0 flex-1 rounded-full bg-surface px-4 outline-none placeholder:text-secondary focus:ring-2 focus:ring-primary/40" placeholder="Ask Tony: what should I focus on this week?" aria-label="Ask Tony" value={say} onChange={(event) => setSay(event.target.value)} enterKeyHint="send" />
          <button type="submit" aria-label="Send" disabled={!say.trim() || sending} className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-white transition-opacity disabled:opacity-40">
            {Icon.send}
          </button>
        </div>
      </form>
    </>
  );
}

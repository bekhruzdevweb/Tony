"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "@/lib/app-types";
import { layoutDay } from "@/lib/day-calendar";
import type { Task } from "@/lib/tasks";
import { localDate, minuteOfDay } from "@/lib/time";
import { shiftDay, weekStart } from "@/lib/week-rules";
import { clockOf } from "./block-style";
import { isOpen } from "./ui";

const TZ = "Asia/Tashkent";
const HOUR_PX = 56;
const GUTTER = 56;
/** A little air above 00:00, so its label is not cut off. */
const TOP = 12;
const noon = (day: string) => new Date(`${day}T12:00:00+05:00`);
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);
const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;
const shiftMonth = (day: string, by: number) => {
  const total = Number(day.slice(0, 4)) * 12 + (Number(day.slice(5, 7)) - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
};
const weekDays = (day: string) => Array.from({ length: 7 }, (_, index) => shiftDay(weekStart(day), index));

type View = "day" | "week" | "month";
type Open = { onOpen: (task: Task) => void; onToggle: (task: Task) => void };

/** The tint every calendar app uses for an event: a soft wash of its colour with a bar on the left. */
const wash = (color: string, open: boolean) => (open ? `color-mix(in srgb, ${color} 16%, var(--background))` : "var(--surface)");
const inkOf = (color: string, open: boolean) => (open ? `color-mix(in srgb, ${color} 72%, var(--ink))` : "var(--secondary)");

/**
 * The calendar (27 Nov: "exactly the same as Notion, Google, Apple calendar"): a month at the left to jump
 * around in, Day / Week / Month views, a full 24 hour grid with the hours on its lines, events as a soft wash
 * of their life area's colour with a bar on the left, tasks with no time in a row above the hours, and a red
 * line with a dot for now. A tap on a block opens it; a tap on an empty hour adds a task on that day.
 */
export function CalendarScreen({ state, now, onOpen, onToggle, onAdd }: { state: AppState; now: Date; onAdd: (target?: { day?: string }) => void } & Open) {
  const today = localDate(now);
  const [focus, setFocus] = useState(today);
  const [view, setView] = useState<View>("week");
  const [mini, setMini] = useState(firstOfMonth(today));

  // A phone opens on one day at a time.
  useEffect(() => {
    const timer = setTimeout(() => window.matchMedia("(max-width: 767px)").matches && setView("day"), 0);
    return () => clearTimeout(timer);
  }, []);

  const go = (day: string) => (setFocus(day), setMini(firstOfMonth(day)));
  const step = (direction: 1 | -1) => go(view === "month" ? shiftMonth(focus, direction) : shiftDay(focus, direction * (view === "week" ? 7 : 1)));
  const colorOf = (task: Task) => state.projects.find((project) => project.id === task.project_id)?.color ?? "#007AFF";
  const busy = useMemo(() => new Set(state.tasks.filter((task) => isOpen(task) && task.due_at && task.kind !== "prayer").map((task) => localDate(new Date(task.due_at!)))), [state.tasks]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-3 md:px-6 md:pt-5">
        <h1 className="mr-auto text-[22px] leading-tight tracking-tight md:text-[26px]">
          <span className="font-bold">{fmt(noon(focus), { month: "long" })}</span> <span className="font-normal text-secondary">{focus.slice(0, 4)}</span>
        </h1>
        <div className="grid grid-cols-3 rounded-[10px] bg-surface p-0.5" role="tablist" aria-label="View">
          {(["day", "week", "month"] as const).map((option) => (
            <button key={option} type="button" role="tab" aria-selected={view === option} onClick={() => setView(option)} className={`h-7 rounded-[8px] px-3 text-[13px] font-medium capitalize ${view === option ? "bg-background shadow-sm" : "text-secondary"}`}>
              {option}
            </button>
          ))}
        </div>
        <div className="flex items-center text-secondary">
          <button type="button" aria-label="Previous" onClick={() => step(-1)} className="grid size-9 place-items-center rounded-full text-[20px] hover:bg-surface">‹</button>
          <button type="button" onClick={() => go(today)} className="h-8 rounded-full px-3 text-[13px] font-medium text-ink hover:bg-surface">Today</button>
          <button type="button" aria-label="Next" onClick={() => step(1)} className="grid size-9 place-items-center rounded-full text-[20px] hover:bg-surface">›</button>
        </div>
        <button type="button" onClick={() => onAdd({ day: focus })} className="h-8 rounded-full bg-primary px-4 text-[13px] font-semibold text-white">+ Task</button>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 px-3 pb-3 md:px-6">
        <aside className="hidden w-[236px] shrink-0 lg:block" aria-label="Pick a day">
          <MiniMonth month={mini} focus={focus} today={today} view={view} busy={busy} onMonth={(by) => setMini(shiftMonth(mini, by))} onPick={(day) => (setFocus(day), view === "month" && setMini(firstOfMonth(day)))} />
          <ul className="mt-5 space-y-1.5 px-1">
            {state.projects.map((project) => (
              <li key={project.id} className="flex items-center gap-2 text-[13px] text-secondary">
                <span className="size-2.5 rounded-full" style={{ background: project.color }} />
                <span className="truncate">{project.name}</span>
              </li>
            ))}
          </ul>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[16px] bg-background shadow-[var(--shadow-card)] ring-1 ring-hairline">
          {view === "month" ? (
            <MonthGrid state={state} focus={focus} today={today} colorOf={colorOf} onOpen={onOpen} onDay={(day) => (go(day), setView("day"))} />
          ) : (
            <TimeGrid state={state} now={now} today={today} focus={focus} days={view === "week" ? weekDays(focus) : [focus]} strip={view === "day"} colorOf={colorOf} onPick={go} onOpen={onOpen} onToggle={onToggle} onAdd={onAdd} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The small month: today filled, the shown week or day softly marked, a dot under the days that hold something. */
function MiniMonth({ month, focus, today, view, busy, onMonth, onPick }: { month: string; focus: string; today: string; view: View; busy: Set<string>; onMonth: (by: number) => void; onPick: (day: string) => void }) {
  const cells = Array.from({ length: 42 }, (_, index) => shiftDay(weekStart(month), index));
  const week = new Set(weekDays(focus));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[14px] font-semibold">{fmt(noon(month), { month: "long", year: "numeric" })}</span>
        <span className="flex text-secondary">
          <button type="button" aria-label="Earlier month" onClick={() => onMonth(-1)} className="grid size-7 place-items-center rounded-full text-[17px] hover:bg-surface">‹</button>
          <button type="button" aria-label="Later month" onClick={() => onMonth(1)} className="grid size-7 place-items-center rounded-full text-[17px] hover:bg-surface">›</button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-secondary">
        {["M", "T", "W", "T", "F", "S", "S"].map((letter, index) => <span key={index} className="py-1">{letter}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((day) => {
          const inMonth = day.slice(0, 7) === month.slice(0, 7);
          const marked = view === "day" ? day === focus : view === "week" ? week.has(day) : false;
          return (
            <button key={day} type="button" aria-label={fmt(noon(day), { weekday: "long", month: "long", day: "numeric" })} onClick={() => onPick(day)} className={`relative grid h-8 place-items-center text-[13px] ${marked ? "bg-primary/12" : ""} ${marked && view === "day" ? "rounded-full" : ""}`}>
              <span className={`grid size-7 place-items-center rounded-full ${day === today ? "bg-primary font-semibold text-white" : inMonth ? "text-ink" : "text-secondary/50"}`}>{Number(day.slice(8))}</span>
              {busy.has(day) && day !== today && <span className="absolute bottom-0.5 size-1 rounded-full bg-secondary/60" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The month as a grid of days: a few soft chips in each, and "+n more" opens that day. */
function MonthGrid({ state, focus, today, colorOf, onOpen, onDay }: { state: AppState; focus: string; today: string; colorOf: (task: Task) => string; onOpen: (task: Task) => void; onDay: (day: string) => void }) {
  const month = focus.slice(0, 7);
  const cells = Array.from({ length: 42 }, (_, index) => shiftDay(weekStart(firstOfMonth(focus)), index));
  const rows = cells.slice(35).every((day) => day.slice(0, 7) !== month) ? 5 : 6;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-hairline">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => <span key={name} className="py-2 text-center text-[11.5px] font-medium text-secondary">{name}</span>)}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7" style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
        {cells.slice(0, rows * 7).map((day) => {
          const { blocks, anytime } = layoutDay(state.tasks, day);
          const tasks = [...blocks.map((block) => block.task), ...anytime];
          const inMonth = day.slice(0, 7) === month;
          return (
            <div key={day} className={`relative min-h-0 overflow-hidden border-t border-l border-hairline p-1 first:border-l-0 [&:nth-child(7n+1)]:border-l-0 ${inMonth ? "" : "bg-surface/50"}`}>
              <button type="button" aria-label={`Open ${fmt(noon(day), { weekday: "long", month: "long", day: "numeric" })}`} onClick={() => onDay(day)} className="absolute inset-0 cursor-default" />
              <span className={`relative grid size-6 place-items-center rounded-full text-[12.5px] ${day === today ? "bg-primary font-semibold text-white" : inMonth ? "text-ink" : "text-secondary/60"}`}>{Number(day.slice(8))}</span>
              <div className="relative mt-0.5 space-y-0.5">
                {tasks.slice(0, 3).map((task) => (
                  <Chip key={task.id} task={task} color={colorOf(task)} onOpen={onOpen} />
                ))}
                {tasks.length > 3 && <button type="button" onClick={() => onDay(day)} className="block px-1 text-[11px] font-medium text-secondary">+{tasks.length - 3} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ task, color, onOpen }: { task: Task; color: string; onOpen: (task: Task) => void }) {
  const open = isOpen(task);
  return (
    <button type="button" onClick={() => onOpen(task)} className={`block w-full truncate rounded-[5px] border-l-[3px] px-1.5 py-px text-left text-[11.5px] leading-snug font-medium ${open ? "" : "line-through"}`} style={{ background: wash(color, open), color: inkOf(color, open), borderColor: open ? color : "var(--p4)" }}>
      {task.title}
    </button>
  );
}

/** Day and week: the hours down the left, one column a day, events laid on them. */
function TimeGrid(props: {
  state: AppState;
  now: Date;
  today: string;
  focus: string;
  days: string[];
  /** Day view: the week as a strip of days to switch between. */
  strip: boolean;
  colorOf: (task: Task) => string;
  onPick: (day: string) => void;
  onAdd: (target?: { day?: string }) => void;
} & Open) {
  const { state, now, today, focus, days, strip, colorOf, onPick, onOpen, onToggle, onAdd } = props;
  const laid = days.map((day) => ({ day, ...layoutDay(state.tasks, day) }));
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const top = (minute: number) => (minute / 60) * HOUR_PX + TOP;
  const nowMinute = minuteOfDay(now);
  const anyNoTime = laid.some((entry) => entry.anytime.length > 0);
  const scroller = useRef<HTMLDivElement>(null);
  const columns = { gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(${days.length > 1 ? 96 : 0}px, 1fr))` };
  const key = days.join();

  // Open at the present hour (or the morning, for a day that is not today).
  useEffect(() => {
    const target = days.includes(today) ? nowMinute - 90 : 7 * 60;
    scroller.current?.scrollTo({ top: Math.max(0, top(target) - TOP) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
      <div style={{ minWidth: days.length > 1 ? 720 : undefined }}>
        <div className="sticky top-0 z-20 border-b border-hairline bg-background/95 backdrop-blur">
          {strip && (
            <div className="grid grid-cols-7 border-b border-hairline px-2 py-1.5">
              {weekDays(focus).map((day) => (
                <button key={day} type="button" onClick={() => onPick(day)} className="flex flex-col items-center gap-0.5 py-1">
                  <span className="text-[11px] font-medium text-secondary">{fmt(noon(day), { weekday: "short" })}</span>
                  <span className={`grid size-8 place-items-center rounded-full text-[15px] font-semibold ${day === focus ? (day === today ? "bg-primary text-white" : "bg-ink text-background") : day === today ? "text-primary" : "text-ink"}`}>{Number(day.slice(8))}</span>
                </button>
              ))}
            </div>
          )}
          {!strip && (
            <div className="grid" style={columns}>
              <span />
              {days.map((day) => (
                <button key={day} type="button" onClick={() => onPick(day)} className="flex flex-col items-center gap-0.5 border-l border-hairline py-2">
                  <span className={`text-[11px] font-semibold tracking-wide uppercase ${day === today ? "text-primary" : "text-secondary"}`}>{fmt(noon(day), { weekday: "short" })}</span>
                  <span className={`grid size-8 place-items-center rounded-full text-[18px] font-medium ${day === today ? "bg-primary text-white" : "text-ink"}`}>{Number(day.slice(8))}</span>
                </button>
              ))}
            </div>
          )}
          {anyNoTime && (
            <div className="grid border-t border-hairline" style={columns}>
              <span className="self-center pr-2 text-right text-[10.5px] leading-tight text-secondary">no time</span>
              {laid.map(({ day, anytime }) => (
                <div key={day} className="min-w-0 space-y-0.5 border-l border-hairline p-1">
                  {anytime.map((task) => {
                    const open = isOpen(task);
                    const color = colorOf(task);
                    return (
                      <div key={task.id} className="flex items-center rounded-[5px] border-l-[3px]" style={{ background: wash(color, open), borderColor: open ? color : "var(--p4)" }}>
                        <button type="button" onClick={() => onOpen(task)} className={`min-w-0 flex-1 truncate py-0.5 pl-1.5 text-left text-[11.5px] font-medium ${open ? "" : "line-through"}`} style={{ color: inkOf(color, open) }}>
                          {task.title}
                        </button>
                        {open && (
                          <button type="button" aria-label={`Done: ${task.title}`} onClick={() => onToggle(task)} className="grid size-6 shrink-0 place-items-center">
                            <span className="size-3.5 rounded-full border-[1.5px]" style={{ borderColor: color }} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="relative grid" style={{ ...columns, height: 24 * HOUR_PX + TOP * 2 }}>
          <div className="relative">
            {hours.slice(1).map((hour) => (
              <span key={hour} className="absolute right-2 -translate-y-1/2 text-[11px] text-secondary tabular-nums" style={{ top: top(hour * 60) }}>
                {String(hour).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {laid.map(({ day, blocks }) => (
            <div key={day} className="relative border-l border-hairline">
              {hours.map((hour) => (
                <span key={hour} className="absolute inset-x-0 h-px bg-hairline" style={{ top: top(hour * 60) }} />
              ))}
              <button type="button" aria-label={`Add a task on ${fmt(noon(day), { weekday: "long" })}`} onClick={() => onAdd({ day })} className="absolute inset-0 cursor-default" />
              {blocks.map(({ task, start, minutes, column, columns: across }) => {
                const open = isOpen(task);
                const color = colorOf(task);
                const height = Math.max((minutes / 60) * HOUR_PX - 2, 20);
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onOpen(task)}
                    className="absolute flex flex-col justify-start overflow-hidden rounded-[6px] border-l-[3px] px-1.5 py-0.5 text-left"
                    style={{ top: top(start) + 1, height, left: `calc(${(column / across) * 100}% + 2px)`, width: `calc(${100 / across}% - 5px)`, background: wash(color, open), borderColor: open ? color : "var(--p4)", color: inkOf(color, open) }}
                  >
                    <span className={`block text-[12px] leading-tight font-semibold ${height >= 56 ? "line-clamp-2" : "truncate"} ${open ? "" : "line-through"}`}>{task.title}</span>
                    {height >= 36 && <span className="block text-[11px] tabular-nums opacity-80">{clockOf(start)} – {clockOf(start + minutes)}</span>}
                  </button>
                );
              })}
              {day === today && (
                <span className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: top(nowMinute) - 4, height: 8 }} aria-label={`Now, ${clockOf(nowMinute)}`}>
                  <span className="-ml-1 size-2 shrink-0 rounded-full bg-overdue" />
                  <span className="h-[2px] flex-1 bg-overdue" />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

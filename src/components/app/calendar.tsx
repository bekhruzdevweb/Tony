"use client";

import { useState } from "react";
import type { AppState } from "@/lib/app-types";
import { layoutDay } from "@/lib/day-calendar";
import type { Task } from "@/lib/tasks";
import { formatTime, localDate } from "@/lib/time";
import { isOpen } from "./ui";

const TZ = "Asia/Tashkent";
const DAY_MS = 24 * 60 * 60_000;
const noon = (day: string) => new Date(`${day}T12:00:00+05:00`);
const shift = (day: string, days: number) => localDate(new Date(noon(day).getTime() + days * DAY_MS));
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);

/**
 * The week at a glance (24 Nov: the hour-by-hour day was "weird"; he asked for a weekly calendar that is
 * "very easy to understand"). Seven days side by side, each a short list in time order: no hours, no blocks.
 */
export function WeekCalendar({ state, now, onOpen, onToggle, onAdd, week }: { state: AppState; now: Date; onOpen: (task: Task) => void; onToggle: (task: Task) => void; onAdd: (target?: { day?: string }) => void; /** A fixed week (its Monday): the weekly planner chooses it, and the header is left out. */ week?: string }) {
  const today = localDate(now);
  const [own, setStart] = useState(today);
  const start = week ?? own;
  const days = Array.from({ length: 7 }, (_, index) => shift(start, index));
  // A task wears its life area's colour, here as on the dashboard.
  const colorOf = (task: Task) => state.projects.find((project) => project.id === task.project_id)?.color ?? "var(--primary)";
  const last = days[6];
  const range = `${fmt(noon(start), { month: "short", day: "numeric" })} – ${fmt(noon(last), start.slice(5, 7) === last.slice(5, 7) ? { day: "numeric" } : { month: "short", day: "numeric" })}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!week && (
      <div className="flex shrink-0 items-center justify-between px-4 pt-2 pb-2 md:px-8 md:pt-6">
        <h1 className="text-title leading-tight font-bold tracking-tight">{range}</h1>
        <div className="flex items-center text-secondary">
          <button type="button" aria-label="Earlier week" onClick={() => setStart(shift(start, -7))} className="grid size-10 place-items-center rounded-full text-[20px] hover:bg-surface">‹</button>
          <button type="button" onClick={() => setStart(today)} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">This week</button>
          <button type="button" aria-label="Later week" onClick={() => setStart(shift(start, 7))} className="grid size-10 place-items-center rounded-full text-[20px] hover:bg-surface">›</button>
        </div>
      </div>
      )}

      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-3 md:px-6 lg:grid lg:grid-cols-7 lg:overflow-x-visible">
        {days.map((day) => {
          const { blocks, anytime } = layoutDay(state.tasks, day);
          const tasks = [...blocks.map((block) => block.task), ...anytime];
          const left = tasks.filter(isOpen).length;
          const isToday = day === today;
          return (
            <section key={day} aria-label={fmt(noon(day), { weekday: "long", month: "short", day: "numeric" })} className={`flex min-h-0 w-[46%] shrink-0 snap-start flex-col rounded-card md:w-[30%] lg:w-auto ${isToday ? "bg-primary/6" : "bg-surface"}`}>
              <header className="flex shrink-0 items-center gap-2 px-2.5 pt-2.5 pb-1.5">
                <span className={`grid size-8 shrink-0 place-items-center rounded-full text-[15px] font-semibold ${isToday ? "bg-primary text-white" : "text-ink"}`}>{Number(day.slice(8))}</span>
                <span className={`text-[13px] font-medium ${isToday ? "text-primary" : "text-secondary"}`}>{isToday ? "Today" : fmt(noon(day), { weekday: "short" })}</span>
                <span className="flex-1" />
                {left > 0 && <span className="text-[12px] text-secondary">{left}</span>}
              </header>
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-1.5">
                {tasks.map((task) => {
                  const open = isOpen(task);
                  return (
                    <li key={task.id} className="rounded-[10px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.05)]" style={{ borderLeft: `3px solid ${open ? colorOf(task) : "var(--p4)"}` }}>
                      <div className="flex items-center justify-between pl-2">
                        <span className="text-[11px] text-secondary">{task.anytime ? "no time" : formatTime(new Date(task.due_at!))}</span>
                        {open ? (
                          <button type="button" aria-label={`Done: ${task.title}`} onClick={() => onToggle(task)} className="grid size-7 shrink-0 place-items-center">
                            <span className="size-4 rounded-full border-[1.6px] border-p4" />
                          </button>
                        ) : (
                          <span className="size-7" />
                        )}
                      </div>
                      <button type="button" onClick={() => onOpen(task)} className="-mt-1 block w-full px-2 pb-1.5 text-left">
                        <span className={`line-clamp-3 text-[13px] leading-snug font-medium break-words ${open ? "text-ink" : "text-secondary line-through"}`}>{task.title}</span>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button type="button" onClick={() => onAdd({ day })} aria-label="Add a task on this day" className="flex h-8 w-full items-center justify-center rounded-[10px] text-[18px] text-secondary hover:bg-background hover:text-primary">
                    +
                  </button>
                </li>
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

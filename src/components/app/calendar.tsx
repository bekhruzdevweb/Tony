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
const tint = (task: Task) => (task.priority === 1 ? "var(--p1)" : task.priority === 2 ? "var(--p2)" : "var(--primary)");

/**
 * The week at a glance (24 Nov: the hour-by-hour day was "weird"; he asked for a weekly calendar that is
 * "very easy to understand"). Seven days side by side, each a short list in time order: no hours, no blocks.
 */
export function WeekCalendar({ state, now, onOpen, onToggle, onAdd }: { state: AppState; now: Date; onOpen: (task: Task) => void; onToggle: (task: Task) => void; onAdd: (target?: { day?: string }) => void }) {
  const today = localDate(now);
  const [start, setStart] = useState(today);
  const days = Array.from({ length: 7 }, (_, index) => shift(start, index));
  const last = days[6];
  const range = `${fmt(noon(start), { month: "short", day: "numeric" })} – ${fmt(noon(last), start.slice(5, 7) === last.slice(5, 7) ? { day: "numeric" } : { month: "short", day: "numeric" })}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pt-2 pb-2 md:px-8 md:pt-6">
        <h1 className="text-title leading-tight font-bold tracking-tight">{range}</h1>
        <div className="flex items-center text-secondary">
          <button type="button" aria-label="Earlier week" onClick={() => setStart(shift(start, -7))} className="grid size-10 place-items-center rounded-full text-[20px] hover:bg-surface">‹</button>
          <button type="button" onClick={() => setStart(today)} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">This week</button>
          <button type="button" aria-label="Later week" onClick={() => setStart(shift(start, 7))} className="grid size-10 place-items-center rounded-full text-[20px] hover:bg-surface">›</button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-3 md:px-6 lg:grid lg:grid-cols-7 lg:overflow-x-visible">
        {days.map((day) => {
          const { blocks, anytime } = layoutDay(state.tasks, day);
          const tasks = [...blocks.map((block) => block.task), ...anytime];
          const left = tasks.filter(isOpen).length;
          const isToday = day === today;
          return (
            <section key={day} aria-label={fmt(noon(day), { weekday: "long", month: "short", day: "numeric" })} className={`flex min-h-0 w-[46%] shrink-0 snap-start flex-col rounded-card md:w-[30%] lg:w-auto ${isToday ? "bg-primary/6" : "bg-surface"}`}>
              <header className="flex shrink-0 items-center gap-2 px-2.5 pt-2.5 pb-1.5">
                <span className={`grid size-8 place-items-center rounded-full text-[15px] font-semibold ${isToday ? "bg-primary text-white" : "text-ink"}`}>{Number(day.slice(8))}</span>
                <span className={`text-[13px] font-medium ${isToday ? "text-primary" : "text-secondary"}`}>{isToday ? "Today" : fmt(noon(day), { weekday: "short" })}</span>
                <span className="flex-1" />
                {left > 0 && <span className="text-[12px] text-secondary">{left}</span>}
              </header>
              <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-1.5">
                {tasks.map((task) => {
                  const open = isOpen(task);
                  return (
                    <li key={task.id} className="relative rounded-[10px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.05)]" style={{ borderLeft: `3px solid ${open ? tint(task) : "var(--p4)"}` }}>
                      <button type="button" onClick={() => onOpen(task)} className="block w-full py-1.5 pr-7 pl-2 text-left">
                        <span className="block text-[11px] text-secondary">{task.anytime ? "no time" : formatTime(new Date(task.due_at!))}</span>
                        <span className={`line-clamp-2 text-[13px] leading-snug font-medium ${open ? "text-ink" : "text-secondary line-through"}`}>{task.title}</span>
                      </button>
                      {open && (
                        <button type="button" aria-label={`Done: ${task.title}`} onClick={() => onToggle(task)} className="absolute top-1 right-0.5 grid size-7 place-items-center">
                          <span className="size-4 rounded-full border-[1.6px] border-p4" />
                        </button>
                      )}
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

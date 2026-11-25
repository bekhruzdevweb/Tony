"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState } from "@/lib/app-types";
import { layoutDay } from "@/lib/day-calendar";
import type { Task } from "@/lib/tasks";
import { localDate, minuteOfDay } from "@/lib/time";
import { clockOf, inkOn } from "./block-style";
import { isOpen } from "./ui";

const TZ = "Asia/Tashkent";
const DAY_MS = 24 * 60 * 60_000;
const HOUR_PX = 52;
const GUTTER = 52;
const noon = (day: string) => new Date(`${day}T12:00:00+05:00`);
const shift = (day: string, days: number) => localDate(new Date(noon(day).getTime() + days * DAY_MS));
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);

/**
 * The week as a real calendar (26 Nov: "this calendar looks horrible bro, even no time"): the hours down
 * the left, seven day columns, and each timed task a solid block of its life area's colour, as tall as its
 * length, in the same manner as the dashboard's timeline. Tasks with no time sit in a row above the hours.
 * A tap on a block opens it; a tap on an empty day adds a task there. A red line marks now.
 */
export function WeekCalendar({ state, now, onOpen, onToggle, onAdd, week }: { state: AppState; now: Date; onOpen: (task: Task) => void; onToggle: (task: Task) => void; onAdd: (target?: { day?: string }) => void; /** A fixed week (its Monday): the weekly planner chooses it, and the header is left out. */ week?: string }) {
  const today = localDate(now);
  const [own, setStart] = useState(today);
  const start = week ?? own;
  const days = Array.from({ length: 7 }, (_, index) => shift(start, index));
  const last = days[6];
  const range = `${fmt(noon(start), { month: "short", day: "numeric" })} – ${fmt(noon(last), start.slice(5, 7) === last.slice(5, 7) ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
  const colorOf = (task: Task) => state.projects.find((project) => project.id === task.project_id)?.color ?? "#007AFF";
  const laid = days.map((day) => ({ day, ...layoutDay(state.tasks, day) }));
  const all = laid.flatMap((entry) => entry.blocks);
  // His waking day, widened to hold anything earlier or later.
  const from = Math.min(8, ...all.map((block) => Math.floor(block.start / 60)));
  const to = Math.min(24, Math.max(22, ...all.map((block) => Math.ceil((block.start + block.minutes) / 60))));
  const hours = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const top = (minute: number) => ((minute - from * 60) / 60) * HOUR_PX;
  const nowMinute = minuteOfDay(now);
  const anyNoTime = laid.some((entry) => entry.anytime.length > 0);
  const scroller = useRef<HTMLDivElement>(null);

  // Open near the present hour, not at dawn.
  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, top(nowMinute - 120)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const columns = { gridTemplateColumns: `${GUTTER}px repeat(7, minmax(104px, 1fr))` };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!week && (
        <div className="flex shrink-0 items-center justify-between px-4 pt-2 pb-3 md:px-8 md:pt-6">
          <h1 className="text-title leading-tight font-bold tracking-tight">{range}</h1>
          <div className="flex items-center text-secondary">
            <button type="button" aria-label="Earlier week" onClick={() => setStart(shift(start, -7))} className="grid size-10 place-items-center rounded-full text-[20px] hover:bg-surface">‹</button>
            <button type="button" onClick={() => setStart(today)} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">This week</button>
            <button type="button" aria-label="Later week" onClick={() => setStart(shift(start, 7))} className="grid size-10 place-items-center rounded-full text-[20px] hover:bg-surface">›</button>
          </div>
        </div>
      )}

      <div ref={scroller} className="mx-3 mb-3 min-h-0 flex-1 overflow-auto rounded-[18px] bg-background shadow-[var(--shadow-card)] ring-1 ring-hairline md:mx-6">
        <div className="min-w-[780px]">
          {/* The days, and under them the tasks with no time: both stay in view while the hours scroll. */}
          <div className="sticky top-0 z-20 border-b border-hairline bg-background/95 backdrop-blur">
            <div className="grid" style={columns}>
              <span />
              {days.map((day) => {
                const isToday = day === today;
                return (
                  <div key={day} className="flex flex-col items-center gap-0.5 border-l border-hairline py-2">
                    <span className={`text-[11.5px] font-medium ${isToday ? "text-primary" : "text-secondary"}`}>{fmt(noon(day), { weekday: "short" })}</span>
                    <span className={`grid size-8 place-items-center rounded-full text-[16px] font-semibold ${isToday ? "bg-primary text-white" : "text-ink"}`}>{Number(day.slice(8))}</span>
                  </div>
                );
              })}
            </div>
            {anyNoTime && (
              <div className="grid border-t border-hairline" style={columns}>
                <span className="self-center pr-2 text-right text-[10.5px] leading-tight text-secondary">no time</span>
                {laid.map(({ day, anytime }) => (
                  <div key={day} className="min-w-0 space-y-1 border-l border-hairline p-1">
                    {anytime.map((task) => {
                      const open = isOpen(task);
                      const color = colorOf(task);
                      return (
                        <div key={task.id} className="flex items-center rounded-[7px]" style={{ background: `color-mix(in srgb, ${open ? color : "var(--p4)"} 16%, var(--background))` }}>
                          <button type="button" onClick={() => onOpen(task)} className={`min-w-0 flex-1 truncate py-1 pl-2 text-left text-[12px] font-medium ${open ? "" : "text-secondary line-through"}`} style={open ? { color: `color-mix(in srgb, ${color} 70%, var(--ink))` } : undefined}>
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

          <div className="relative grid" style={{ ...columns, height: (to - from) * HOUR_PX + 20 }}>
            {/* The hours and their lines. */}
            <div className="relative">
              {hours.map((hour) => (
                <span key={hour} className="absolute right-2 text-[11.5px] text-secondary tabular-nums" style={{ top: top(hour * 60) + 10 - 8 }}>
                  {String(hour % 24).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {laid.map(({ day, blocks }) => (
              <div key={day} className={`relative border-l border-hairline ${day === today ? "bg-primary/[0.035]" : ""}`}>
                {hours.map((hour) => (
                  <span key={hour} className="absolute inset-x-0 h-px bg-hairline" style={{ top: top(hour * 60) + 10 }} />
                ))}
                <button type="button" aria-label={`Add a task on ${fmt(noon(day), { weekday: "long" })}`} onClick={() => onAdd({ day })} className="absolute inset-0 cursor-default" />
                {blocks.map(({ task, start: begins, minutes, column, columns: across }) => {
                  const open = isOpen(task);
                  const color = open ? colorOf(task) : "#d1d1d6";
                  const ink = open ? inkOn(color) : "#6e6e73";
                  const height = Math.max((minutes / 60) * HOUR_PX - 2, 22);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onOpen(task)}
                      className="absolute flex flex-col justify-start overflow-hidden rounded-[9px] px-1.5 py-1 text-left"
                      style={{ top: top(begins) + 11, height, left: `calc(${(column / across) * 100}% + 2px)`, width: `calc(${100 / across}% - 4px)`, background: color, color: ink }}
                    >
                      <span className={`block text-[12px] leading-tight font-semibold tracking-tight ${height >= 64 ? "line-clamp-2" : "truncate"} ${open ? "" : "line-through"}`}>{task.title}</span>
                      {height >= 44 && <span className="mt-0.5 block text-[10.5px] tabular-nums opacity-85">{clockOf(begins)} – {clockOf(begins + minutes)}</span>}
                    </button>
                  );
                })}
                {day === today && nowMinute >= from * 60 && nowMinute <= to * 60 && (
                  <span className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: top(nowMinute) + 10 - 4, height: 8 }} aria-label={`Now, ${clockOf(nowMinute)}`}>
                    <span className="-ml-1 size-2 shrink-0 rounded-full bg-overdue" />
                    <span className="h-[2px] flex-1 bg-overdue" />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

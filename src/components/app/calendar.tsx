"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState } from "@/lib/app-types";
import { hourRange, layoutDay } from "@/lib/day-calendar";
import type { Task } from "@/lib/tasks";
import { formatTime, localDate, minuteOfDay } from "@/lib/time";
import { formatMinutes, isOpen } from "./ui";

const TZ = "Asia/Tashkent";
const HOUR_PX = 60;
const DAY_MS = 24 * 60 * 60_000;
const noon = (day: string) => new Date(`${day}T12:00:00+05:00`);
const shift = (day: string, days: number) => localDate(new Date(noon(day).getTime() + days * DAY_MS));
const fmt = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options }).format(at);
const tint = (task: Task) => (task.priority === 1 ? "var(--p1)" : task.priority === 2 ? "var(--p2)" : "var(--primary)");

/**
 * A day as blocks of time (24 Nov: "I want to have list and plus calendar … overwhelmed with the text").
 * A week strip picks the day; tasks with no time sit above the hours; a tap opens the task.
 */
export function DayCalendar({ state, now, onOpen, onToggle, onAdd }: { state: AppState; now: Date; onOpen: (task: Task) => void; onToggle: (task: Task) => void; onAdd: (target?: { day?: string }) => void }) {
  const today = localDate(now);
  const [day, setDay] = useState(today);
  const [weekStart, setWeekStart] = useState(today);
  const { blocks, anytime, prayers } = layoutDay(state.tasks, day);
  const { from, to } = hourRange(blocks, prayers);
  const hours = Array.from({ length: to - from }, (_, index) => from + index);
  const top = (minute: number) => ((minute - from * 60) / 60) * HOUR_PX;
  const nowMinute = minuteOfDay(now);
  const scroller = useRef<HTMLDivElement>(null);

  // Open at the present hour (or the day's first task), not at dawn.
  useEffect(() => {
    const anchor = day === today ? nowMinute - 90 : (blocks[0]?.start ?? from * 60) - 30;
    scroller.current?.scrollTo({ top: Math.max(0, top(anchor)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const count = (date: string) => state.tasks.filter((task) => task.due_at && task.kind !== "prayer" && isOpen(task) && localDate(new Date(task.due_at)) === date).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-3 md:px-5">
        <h2 className="text-body font-semibold">{fmt(noon(day), { weekday: "long", month: "short", day: "numeric" })}</h2>
        <div className="flex items-center text-secondary">
          <button type="button" aria-label="Earlier week" onClick={() => setWeekStart(shift(weekStart, -7))} className="grid size-9 place-items-center rounded-full hover:bg-surface">‹</button>
          <button type="button" onClick={() => (setWeekStart(today), setDay(today))} className="h-8 rounded-full px-3 text-[13px] font-medium text-primary hover:bg-surface">Today</button>
          <button type="button" aria-label="Later week" onClick={() => setWeekStart(shift(weekStart, 7))} className="grid size-9 place-items-center rounded-full hover:bg-surface">›</button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 px-3 pt-1 pb-2 md:px-4">
        {Array.from({ length: 7 }, (_, index) => shift(weekStart, index)).map((date) => {
          const chosen = date === day;
          const tasks = count(date);
          return (
            <button key={date} type="button" aria-pressed={chosen} onClick={() => setDay(date)} className="flex flex-col items-center gap-1 rounded-xl py-1.5">
              <span className={`text-[11px] font-medium ${date === today ? "text-primary" : "text-secondary"}`}>{fmt(noon(date), { weekday: "short" })}</span>
              <span className={`grid size-8 place-items-center rounded-full text-[15px] font-semibold ${chosen ? "bg-primary text-white" : date === today ? "text-primary" : "text-ink"}`}>{Number(date.slice(8))}</span>
              <span className={`size-1 rounded-full ${tasks ? (tasks > 5 ? "bg-p2" : "bg-secondary/50") : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>

      {anytime.length > 0 && (
        <div className="border-t border-hairline px-4 py-2 md:px-5">
          <p className="mb-1.5 text-[11px] font-medium tracking-wide text-secondary uppercase">No time</p>
          <div className="flex flex-wrap gap-1.5">
            {anytime.map((task) => (
              <button key={task.id} type="button" onClick={() => onOpen(task)} className={`max-w-full truncate rounded-full bg-surface px-3 py-1 text-[13px] ${isOpen(task) ? "text-ink" : "text-secondary line-through"}`}>
                {task.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto border-t border-hairline">
        <div className="relative mr-3 ml-14 md:mr-4" style={{ height: hours.length * HOUR_PX + 16 }}>
          {hours.map((hour) => (
            <div key={hour} className="absolute inset-x-0 border-t border-hairline" style={{ top: top(hour * 60) + 8 }}>
              <span className="absolute -top-2 -left-12 w-9 text-right text-[11px] text-secondary">{String(hour).padStart(2, "0")}:00</span>
            </div>
          ))}
          <button type="button" aria-label="Add a task on this day" onClick={() => onAdd({ day })} className="absolute inset-0 cursor-default" />

          {prayers.map((prayer) => (
            <div key={prayer.id} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-prayer/50" style={{ top: top(minuteOfDay(new Date(prayer.due_at!))) + 8 }}>
              <span className="absolute -top-2 right-0 bg-background pl-1.5 text-[10.5px] text-prayer">{prayer.title.replace(/^Pray:?\s*/i, "")} {formatTime(new Date(prayer.due_at!))}</span>
            </div>
          ))}

          {blocks.map(({ task, start, minutes, column, columns }) => {
            const open = isOpen(task);
            const late = open && day === today && start + minutes < nowMinute && task.status !== "in_progress";
            const color = late ? "var(--overdue)" : tint(task);
            const height = Math.max((minutes / 60) * HOUR_PX - 2, 26);
            return (
              <div
                key={task.id}
                className="absolute overflow-hidden rounded-[10px]"
                style={{
                  top: top(start) + 9,
                  height,
                  left: `calc(${(column / columns) * 100}% + 1px)`,
                  width: `calc(${100 / columns}% - 3px)`,
                  background: `color-mix(in srgb, ${color} ${open ? 13 : 6}%, var(--background))`,
                  borderLeft: `3px solid ${open ? color : "var(--p4)"}`,
                }}
              >
                <button type="button" onClick={() => onOpen(task)} className="flex size-full items-start gap-1.5 py-1 pr-8 pl-2 text-left">
                  <span className="min-w-0">
                    <span className={`block truncate text-[13px] leading-tight font-medium ${open ? "text-ink" : "text-secondary line-through"}`}>{task.title}</span>
                    {height >= 40 && (
                      <span className="block truncate text-[11px] text-secondary">
                        {formatTime(new Date(task.due_at!))}
                        {task.duration_minutes ? ` · ${formatMinutes(task.duration_minutes)}` : ""}
                      </span>
                    )}
                  </span>
                </button>
                {open && columns <= 2 && (
                  <button type="button" aria-label={`Done: ${task.title}`} onClick={() => onToggle(task)} className="absolute top-1 right-1 grid size-6 place-items-center">
                    <span className="size-4 rounded-full border-[1.6px]" style={{ borderColor: color }} />
                  </button>
                )}
              </div>
            );
          })}

          {day === today && nowMinute >= from * 60 && nowMinute <= to * 60 && (
            <div className="pointer-events-none absolute inset-x-0 z-10 border-t-[1.5px] border-overdue" style={{ top: top(nowMinute) + 8 }}>
              <span className="absolute -top-[4.5px] -left-1 size-2 rounded-full bg-overdue" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

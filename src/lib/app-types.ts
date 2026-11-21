/** Shapes shared by the app's server and its screens. No server code here. */
import type { Task } from "./tasks";

export type AppProject = { id: number; name: string; color: string; sort_order: number };
export type AppMessage = { id: number; role: "user" | "tony"; text: string; channel: "telegram" | "app"; created_at: string };
export type AppMemory = { id: number; fact: string; created_at: string };

export type AppSettings = {
  brief_morning: string;
  brief_evening: string;
  quiet_start: string;
  quiet_end: string;
  persistent_schedule: number[];
};

export type AppStatus = {
  telegram: boolean;
  database: boolean;
  brain: boolean;
  clock: boolean;
  lastTick: string | null;
  model: string;
  voiceModel: string;
  botUsername: string | null;
};

/** A schedule Tony proposed, with his reasons. */
export type AppPlan = {
  id: number;
  scope: "day" | "week";
  day: string;
  items: { task_id: number; title: string; at: string; why: string }[];
  left_out: { task_id: number; title: string; why: string }[];
  why: string;
  planned_by: "model" | "rules";
  status: "proposed" | "applied" | "dismissed";
  created_at: string;
};

/** A photo or file attached to a task. `url` is a temporary link to the stored copy, when there is one. */
export type AppMedia = {
  id: number;
  task_id: number;
  kind: "photo" | "video" | "document" | "voice" | "audio" | "animation" | "video_note";
  url: string | null;
  caption: string | null;
  description: string | null;
  note: string | null;
};

/** One part of a task (a subtask). */
export type AppSubtask = { id: number; task_id: number; title: string; done: boolean; position: number };

export type AppState = {
  now: string;
  tasks: Task[];
  projects: AppProject[];
  memory: AppMemory[];
  messages: AppMessage[];
  plans: AppPlan[];
  media: AppMedia[];
  /** Tasks' parts, ordered. */
  subtasks: AppSubtask[];
  settings: AppSettings;
  status: AppStatus;
};

export type AppResult = { ok: true; state: AppState; reply?: string } | { ok: false; error: string; state?: AppState };

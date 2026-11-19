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

export type AppState = {
  now: string;
  tasks: Task[];
  projects: AppProject[];
  memory: AppMemory[];
  messages: AppMessage[];
  settings: AppSettings;
  status: AppStatus;
};

export type AppResult = { ok: true; state: AppState; reply?: string } | { ok: false; error: string; state?: AppState };

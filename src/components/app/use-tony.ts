"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppResult, AppState } from "@/lib/app-types";
import { haptic, tonyFetch } from "./telegram";

const POLL_MS = 4000;

/**
 * The app's data: one state object, re-read every few seconds while the app
 * is on screen, so a task made in Telegram shows up here without a refresh.
 */
export function useTony(initial: AppState) {
  const [state, setState] = useState(initial);
  const [toast, setToast] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const busy = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((text: string, tone: "info" | "error" = "info") => {
    clearTimeout(toastTimer.current);
    setToast({ text, tone });
    toastTimer.current = setTimeout(() => setToast(null), tone === "error" ? 5000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    // A change is on its way; its answer will carry newer state than a poll could.
    if (busy.current > 0) return;
    try {
      const response = await tonyFetch("/api/app", { cache: "no-store" });
      if (response.status === 401) return setSignedOut(true);
      const result = (await response.json()) as AppResult;
      if (result.ok && busy.current === 0) setState(result.state);
    } catch {
      // Offline or a blip: keep showing what we have and try again on the next beat.
    }
  }, []);

  useEffect(() => {
    const beat = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  /** Sends one change. `optimistic` is applied at once so taps feel instant. */
  const act = useCallback(
    async (action: string, payload: Record<string, unknown> = {}, optimistic?: (s: AppState) => AppState): Promise<AppResult> => {
      busy.current++;
      if (optimistic) setState(optimistic);
      try {
        const response = await tonyFetch("/api/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...payload }),
        });
        if (response.status === 401) setSignedOut(true);
        const result = (await response.json()) as AppResult;
        if (result.state) setState(result.state);
        if (!result.ok) {
          haptic("error");
          say(result.error, "error");
        }
        return result;
      } catch {
        say("No connection. That change was not saved.", "error");
        return { ok: false, error: "offline" };
      } finally {
        busy.current--;
      }
    },
    [say],
  );

  return { state, setState, act, refresh, toast, say, signedOut };
}

export type Tony = ReturnType<typeof useTony>;

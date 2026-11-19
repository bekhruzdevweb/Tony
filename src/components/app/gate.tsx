"use client";

import { useEffect, useState } from "react";
import type { AppResult, AppState } from "@/lib/app-types";
import { Login } from "./login";
import { applyTelegramTheme, tonyFetch, webApp } from "./telegram";
import { TonyApp } from "./tony-app";

/**
 * Shown to a visitor with no session. Inside Telegram it signs in by itself
 * with Telegram's data and opens the app; anywhere else it asks for the key.
 */
export function Gate({ botUsername, expired }: { botUsername: string | null; expired: boolean }) {
  const [phase, setPhase] = useState<"checking" | "login" | "refused">("checking");
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stopTheme = applyTelegramTheme();
    (async () => {
      const app = webApp();
      if (!app) return setPhase("login");
      try {
        const signIn = await fetch("/api/auth/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: app.initData }),
        });
        if (!signIn.ok) return !cancelled && setPhase("refused");
        const result = (await (await tonyFetch("/api/app", { cache: "no-store" })).json()) as AppResult;
        if (cancelled) return;
        if (result.ok) setState(result.state);
        else setPhase("refused");
      } catch {
        if (!cancelled) setPhase("refused");
      }
    })();
    return () => {
      cancelled = true;
      stopTheme();
    };
  }, []);

  if (state) return <TonyApp initial={state} />;
  if (phase === "login") return <Login botUsername={botUsername} expired={expired} />;
  return (
    <main className="grid min-h-dvh place-items-center px-8 text-center text-secondary">
      {phase === "checking" ? "One moment, sir…" : "This is Tony's private app, and Telegram says you are not his owner."}
    </main>
  );
}

"use client";

import Image from "next/image";
import { useState } from "react";

/** Sign-in: a six-digit code that Tony hands out in Telegram. */
export function Login({ botUsername, expired }: { botUsername: string | null; expired: boolean }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(expired ? "That key has expired. Send /app to Tony for a new one." : "");
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: value }) });
      const result = await response.json();
      if (result.ok) return window.location.replace("/");
      setError(result.error ?? "That did not work. Try again.");
    } catch {
      setError("No connection. Try again.");
    }
    setCode("");
    setBusy(false);
  };

  const onChange = (value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) void submit(digits);
  };

  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-20 pb-10">
      <Image src="/brand/avatar.png" alt="" width={64} height={64} priority className="size-16 rounded-full shadow-lg shadow-accent/25" />
      <h1 className="mt-6 text-title leading-tight font-bold tracking-tight">Tony</h1>
      <p className="mt-2 text-body text-secondary">
        Good day, sir. Send <span className="font-semibold text-ink">/app</span> to me in Telegram and enter the key I give you.
      </p>

      <label className="mt-10 block">
        <span className="mb-2 block px-1 text-caption font-medium tracking-wide text-secondary uppercase">Six-digit key</span>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-describedby="login-error"
          placeholder="000 000"
          value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy}
          className="h-14 w-full rounded-card bg-surface px-4 text-center text-[28px] font-semibold tracking-[0.2em] outline-none placeholder:text-secondary/40 focus:ring-2 focus:ring-primary/40"
        />
      </label>
      <p id="login-error" role="alert" className="mt-3 min-h-5 px-1 text-sub text-overdue">
        {error}
      </p>

      {botUsername && (
        <a href={`https://t.me/${botUsername}`} className="mt-4 grid h-12 place-items-center rounded-card text-body font-semibold text-white" style={{ background: "var(--tony-gradient)" }}>
          Open Telegram
        </a>
      )}
    </main>
  );
}

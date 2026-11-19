import Image from "next/image";
import { connection } from "next/server";
import { env } from "@/lib/env";

function Row({ label, hint, ready }: { label: string; hint: string; ready: boolean }) {
  return (
    <li className="flex min-h-11 items-center gap-3 px-4 py-3">
      <span
        aria-hidden
        className={`size-2.5 shrink-0 rounded-full ${ready ? "bg-done" : "bg-hairline ring-1 ring-secondary/40"}`}
      />
      <span className="flex-1">
        <span className="block text-body leading-snug">{label}</span>
        <span className="block text-caption text-secondary">{hint}</span>
      </span>
      <span className={`text-secondary text-caption ${ready ? "" : "font-medium text-ink"}`}>
        {ready ? "Ready" : "Missing"}
      </span>
    </li>
  );
}

export default async function Home() {
  // Read the environment on each request, so a redeploy is not needed to see changes.
  await connection();

  const rows = [
    {
      label: "Telegram bot",
      hint: "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET",
      ready: Boolean(env.telegramBotToken && env.telegramWebhookSecret),
    },
    {
      label: "Owner lock",
      hint: "TELEGRAM_OWNER_ID, so Tony answers only you",
      ready: env.telegramOwnerId !== undefined,
    },
    {
      label: "Database",
      hint: "SUPABASE_URL and SUPABASE_SECRET_KEY",
      ready: Boolean(env.supabaseUrl && env.supabaseSecretKey),
    },
  ];
  const allReady = rows.every((row) => row.ready);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-20 pb-10">
      <Image
        src="/brand/avatar.png"
        alt=""
        width={64}
        height={64}
        priority
        className="size-16 rounded-full shadow-lg shadow-accent/25"
      />
      <h1 className="mt-6 text-title leading-tight font-bold tracking-tight">Tony</h1>
      <p className="mt-2 text-body text-secondary">
        {allReady
          ? "Everything is connected, sir. Send /ping in Telegram."
          : "The site is up, sir. A few connections are still to be made."}
      </p>

      <h2 className="mt-10 mb-2 px-1 text-caption font-medium tracking-wide text-secondary uppercase">
        Setup
      </h2>
      <ul className="divide-y divide-hairline rounded-card bg-surface">
        {rows.map((row) => (
          <Row key={row.label} {...row} />
        ))}
      </ul>

      <p className="mt-auto pt-10 text-center text-caption text-secondary">
        Phase 1 of 8 · Setup
      </p>
    </main>
  );
}

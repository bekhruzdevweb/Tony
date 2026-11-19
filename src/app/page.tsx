import { connection } from "next/server";
import { Login } from "@/components/app/login";
import { TonyApp } from "@/components/app/tony-app";
import { loadAppState } from "@/lib/app-state";
import { getBot } from "@/lib/bot";
import { hasSession } from "@/lib/session";

export default async function Home({ searchParams }: { searchParams: Promise<{ login?: string }> }) {
  await connection();

  if (await hasSession()) {
    return <TonyApp initial={await loadAppState()} />;
  }

  // Signed out: say only what a stranger may know, which is how to ask Tony for a key.
  let botUsername: string | null = null;
  const bot = getBot();
  if (bot) {
    try {
      await bot.init();
      botUsername = bot.botInfo.username;
    } catch {
      botUsername = null;
    }
  }
  return <Login botUsername={botUsername} expired={(await searchParams).login === "expired"} />;
}

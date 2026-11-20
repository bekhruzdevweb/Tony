import "server-only";
import { titleFrom } from "./brain/checks";

/** A page's title, fetched quickly; a readable stand-in from the address if the page will not say. */
export async function fetchTitle(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6_000),
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TonyBot/1.0)", Accept: "text/html" },
    });
    const html = response.ok ? (await response.text()).slice(0, 200_000) : "";
    return titleFrom(html, url);
  } catch {
    return titleFrom("", url);
  }
}

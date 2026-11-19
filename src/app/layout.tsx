import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tony",
  description: "A personal AI agent that keeps your tasks from dying silently.",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Tony", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

// Runs before first paint, so a theme pinned in Settings never flashes the other one.
const themeScript = `try{var t=localStorage.getItem("tony-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {/* Telegram's Mini App bridge. Outside Telegram it loads and does nothing. */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}

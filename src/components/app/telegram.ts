"use client";

/**
 * Everything the app does differently inside Telegram (the Mini App):
 * signing in with Telegram's own data, following its colours, and using its
 * Back button and haptics. Outside Telegram every function here is a no-op
 * or falls back to the browser.
 */
type ThemeParams = Partial<Record<"bg_color" | "secondary_bg_color" | "text_color" | "hint_color" | "section_separator_color", string>>;

type WebApp = {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: ThemeParams;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  onEvent(event: string, handler: () => void): void;
  offEvent(event: string, handler: () => void): void;
  BackButton: { show(): void; hide(): void; onClick(handler: () => void): void; offClick(handler: () => void): void };
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "success" | "warning" | "error"): void;
    selectionChanged(): void;
  };
};

/** Telegram's object, but only when the page really is open inside Telegram. */
export function webApp(): WebApp | undefined {
  if (typeof window === "undefined") return undefined;
  const app = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  return app?.initData ? app : undefined;
}

/** fetch, carrying Telegram's signed sign-in data when inside Telegram. */
export function tonyFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const initData = webApp()?.initData;
  if (!initData) return fetch(input, init);
  return fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Telegram-Init-Data": initData } });
}

/**
 * Tony's own look inside Telegram: bright by default, dark only when he picks it in Settings (24 Nov: the app
 * wore Telegram's dark colours, "boring"). Telegram's header and bars are painted to match.
 */
export function applyTelegramTheme(): () => void {
  const app = webApp();
  if (!app) return () => undefined;
  const root = document.documentElement;
  const paint = () => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("tony-theme");
    } catch {
      saved = null;
    }
    const scheme = saved === "dark" ? "dark" : saved === "system" ? app.colorScheme : "light";
    root.dataset.theme = scheme;
    for (const name of ["--background", "--surface", "--ink", "--secondary", "--sidebar", "--hairline"]) root.style.removeProperty(name);
    const ground = scheme === "dark" ? "#1c1c1e" : "#ffffff";
    app.setHeaderColor?.(ground);
    app.setBackgroundColor?.(ground);
    app.setBottomBarColor?.(ground);
  };
  window.addEventListener("tony-theme", paint);
  paint();
  app.ready();
  app.expand();
  // Dragging a task or scrolling a list must not swipe the app closed.
  app.disableVerticalSwipes?.();
  app.onEvent("themeChanged", paint);
  return () => {
    window.removeEventListener("tony-theme", paint);
    app.offEvent("themeChanged", paint);
  };
}

export function haptic(kind: "tap" | "success" | "error" | "select") {
  const feedback = webApp()?.HapticFeedback;
  if (feedback) {
    if (kind === "tap") feedback.impactOccurred("light");
    else if (kind === "select") feedback.selectionChanged();
    else feedback.notificationOccurred(kind);
    return;
  }
  // Outside Telegram: a light buzz where the browser allows it.
  if (kind !== "select") navigator.vibrate?.(kind === "error" ? [10, 40, 10] : 10);
}

// Telegram's Back button closes whatever was opened last (a sheet, the menu, a sub-page).
const backStack: (() => void)[] = [];
const onBack = () => backStack[backStack.length - 1]?.();

/** While mounted and active, Telegram's Back button runs `handler`. */
export function pushBack(handler: () => void): () => void {
  const app = webApp();
  if (!app) return () => undefined;
  if (backStack.length === 0) {
    app.BackButton.onClick(onBack);
    app.BackButton.show();
  }
  backStack.push(handler);
  return () => {
    const index = backStack.lastIndexOf(handler);
    if (index >= 0) backStack.splice(index, 1);
    if (backStack.length === 0) {
      app.BackButton.offClick(onBack);
      app.BackButton.hide();
    }
  };
}

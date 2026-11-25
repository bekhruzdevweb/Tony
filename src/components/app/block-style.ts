/** Shared by the dashboard's timeline and the week calendar: how a time block reads. */

export const clockOf = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Black or white, whichever reads on a solid block of this colour. */
export function inkOn(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? "#111111" : "#ffffff";
}

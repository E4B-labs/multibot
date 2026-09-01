export const CHAT_SESSION_GAP_MS = 15 * 60 * 1000;

export function shouldStartChatSession(previousAt: number | undefined, at: number): boolean {
  return previousAt === undefined || at - previousAt >= CHAT_SESSION_GAP_MS;
}

export function formatChatSessionTime(at: number, polish: boolean, now = new Date()): string {
  const date = new Date(at);
  const locale = polish ? "pl-PL" : "en-US";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

  if (sameDay(date, now)) return `${polish ? "Dziś" : "Today"} ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return `${polish ? "Wczoraj" : "Yesterday"} ${time}`;

  return `${date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  })} ${time}`;
}

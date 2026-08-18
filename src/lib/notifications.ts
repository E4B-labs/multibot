// Browser notifications stay opt-in and never block in-app badges.
export async function requestBrowserNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") return Notification.requestPermission();
  return Notification.permission;
}

export function notifyBrowser(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(title, { body, tag: `multibot:${title}` }); } catch { /* browser denied it */ }
}

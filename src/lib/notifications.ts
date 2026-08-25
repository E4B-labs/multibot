// Browser notifications stay opt-in and never block in-app badges.
export async function requestBrowserNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") return Notification.requestPermission();
  return Notification.permission;
}

// multibot: jedna banerka na bota — nowa podmienia poprzednią (tag per bot),
// zamiast układać się w stos per zdarzenie. Ikona = kolor maskotki bota.
export function notificationTag(botId?: string): string {
  return botId ? `multibot:${botId}` : "multibot";
}

export function botNotificationIcon(color?: string): string | undefined {
  if (typeof document === "undefined" || !color) return undefined;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

export interface NotifyOptions {
  tag?: string;
  icon?: string;
}

export function notifyBrowser(title: string, body: string, opts: NotifyOptions = {}): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: opts.tag ?? `multibot:${title}`, icon: opts.icon });
  } catch {
    /* browser denied it */
  }
}

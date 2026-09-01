// multibot (U28): powiadomienia push na telefon, gdy bot wchodzi w
// `needsAttention`. Tokeny Expo trzymamy w configu (`pushDevices`); wysyłka
// idzie przez exp.host — Expo nie wymaga uwierzytelnienia dla tokenów, które
// sam wydał, więc żadnego klucza ani pakietu tu nie ma.
//
// Rejestracja: aplikacja mobilna POSTuje token przez route
// `POST /api/devices/:id/push`. Wysyłka: `notifyPushDevices` wołane z
// `server/index.ts` w momencie ustawienia `needsAttention`.
import { loadConfig, saveConfig, type AppConfig, type PushDevice } from "./config.ts";

export function registerPushDevice(id: string, token: string, botId?: string, userId?: string): void {
  const cfg = loadConfig();
  const devices: Record<string, PushDevice> = { ...(cfg.pushDevices ?? {}) };
  devices[id] = { token, botId, userId, updated: Date.now() };
  // saveConfig merguje po kluczu, więc zapis jednego urządzenia nie kasuje reszty
  saveConfig({ pushDevices: devices } as Partial<AppConfig>);
}

export async function notifyPushDevices(
  title: string,
  body: string,
  botId?: string,
  data?: Record<string, string>,
  audienceUserIds?: string[],
): Promise<void> {
  const cfg = loadConfig();
  const devices = cfg.pushDevices ?? {};
  const tokens = Object.values(devices)
    .filter((d) => d.token && (botId == null || d.botId == null || d.botId === botId) && (audienceUserIds === undefined ? true : Boolean(d.userId && audienceUserIds.includes(d.userId))))
    .map((d) => d.token);
  if (tokens.length === 0) return;
  await Promise.allSettled(
    tokens.map((to) =>
      fetch(process.env.MULTIBOT_EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ to, title, body, ...(data ? { data } : {}) }),
      }).catch(() => {}),
    ),
  );
}

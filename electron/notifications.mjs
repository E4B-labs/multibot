// Powiadomienia systemowe powłoki. Reguły trzymamy tu, bez Electrona, żeby
// dało się je przetestować zwykłymi atrapami — tak samo jak single-instance.
//
// Renderer decyduje KIEDY (src/lib/notifications.ts), proces główny tylko
// rysuje banerkę i wie, co zrobić po kliknięciu: podnieść okno i powiedzieć
// interfejsowi, którego bota otworzyć. To działa też w trybie zdalnym —
// preload jest ten sam niezależnie od tego, czyj serwer okno wczytało.
import { activateExistingWindow } from "./single-instance.mjs";

/** Ładunek z renderera jest niezaufany: przycinamy i odrzucamy pusty tytuł. */
export function normalizeNotification(raw) {
  const title = String(raw?.title ?? "").trim().slice(0, 120);
  if (!title) return null;
  const body = String(raw?.body ?? "").trim().slice(0, 400);
  const botId = typeof raw?.botId === "string" && raw.botId ? raw.botId.slice(0, 200) : undefined;
  return botId ? { title, body, botId } : { title, body };
}

/** Kliknięcie w banerkę: okno na wierzch, potem wybór bota w interfejsie. */
export function activateForBot(win, botId) {
  if (!activateExistingWindow(win ? [win] : [])) return false;
  if (botId) win.webContents?.send("desktop:notification-click", botId);
  return true;
}

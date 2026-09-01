import { authFetch } from "@/lib/auth";

// multibot: F11 — jedno wspólne sprawdzenie statusu silnika slafy dla UI
// (wiersz w AppSettingsPanel + warunkowa kropka w Sidebarze). Przez przelotkę
// harnessu (`/api/engine/bots` → engine `/api/bots`, server/engine/proxy.ts),
// NIE `/api/engine/health`: rewrite przelotki celowałby w engine `/api/health`,
// a health silnika żyje w korzeniu `/health` (engine/server/app.py), więc żywy
// silnik oddałby 404 i czytałby się jako offline. GET /api/bots to tania lista
// z dysku. Uwaga: przelotka woła ensureEngine(), więc samo sprawdzenie może
// podnieść silnik — "offline" znaczy "silnika nie da się mieć" (brak venvu
// albo martwy ENGINE_URL), nie "jeszcze nie wystartował".
export async function engineOnline(): Promise<boolean> {
  try {
    return (await authFetch("/api/engine/bots")).ok;
  } catch {
    return false;
  }
}

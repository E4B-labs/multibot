// multibot: sidecar silnika (Python FastAPI z engine/). Harness jest jego
// nadzorcą tylko w sensie "podnieś, jeśli nie stoi" — nie restartuje go, nie
// pilnuje i NIE ubija przy zamknięciu aplikacji.
//
// Trzy ścieżki, w tej kolejności:
//   1. `ENGINE_URL` w env  → inny port loopback (test/dev).
//      Zero spawnu, wyłącznie health-check. Silnik nigdy nie jest zdalny.
//   2. silnik już odpowiada na /health → reattach, zero spawnu.
//   3. nie odpowiada → spawn DETACHED i czekanie na /health.
//
// Sam interpreter (ścieżka 3) też ma kolejność: venv repo (dev) przed runtimem
// dociągniętym do userData przez scripts/provision-engine.mjs (spakowana apka).
//
// DETACHED jest wymogiem, nie optymalizacją: rutyny botów (harmonogramy, webhooki)
// mają chodzić dalej po zamknięciu okna aplikacji, więc proces silnika NIE może
// wisieć na cyklu życia harnessu. Stąd `detached` + `stdio: "ignore"` + `unref()`
// — przytrzymanie stdio dziecka anulowałoby detach.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** repo root: server/engine/ → server/ → repo */
const ROOT = join(HERE, "..", "..");
const ENGINE_DIR = join(ROOT, "engine");
const DEFAULT_URL = "http://127.0.0.1:8700";

export function defaultEngineDataDir(): string {
  const legacy = join(ROOT, "..", "slafy-bot-data");
  return existsSync(join(legacy, "profiles")) ? legacy : join(ENGINE_DIR, "..", "engine-data");
}

export class EngineUnavailableError extends Error {}

/** Python z venvu silnika — ten sam wzór resolvingu co scripts/dev-engine.mjs. */
export function venvPython(engineDir = ENGINE_DIR): string {
  return process.platform === "win32"
    ? join(engineDir, ".venv", "Scripts", "python.exe")
    : join(engineDir, ".venv", "bin", "python");
}

/** Python runtime'u dociąganego przy pierwszym starcie spakowanej apki
 * (scripts/provision-engine.mjs). Katalog podaje electron w `OMB_ENGINE_RUNTIME`
 * — układ jak w provisionerze: `<runtime>/python/`. */
export function runtimePython(runtimeDir = process.env.OMB_ENGINE_RUNTIME): string | null {
  if (!runtimeDir) return null;
  return process.platform === "win32"
    ? join(runtimeDir, "python", "python.exe")
    : join(runtimeDir, "python", "bin", "python3");
}

/** Interpreter, którym da się odpalić silnik, albo `null`. Venv repo idzie
 * pierwszy: gdy ktoś odpala apkę z drzewa dev, jego venv wygrywa z runtimem. */
export function enginePython(): string | null {
  const venv = venvPython();
  if (existsSync(venv)) return venv;
  const runtime = runtimePython();
  return runtime && existsSync(runtime) ? runtime : null;
}

// multibot (G2): explicit, testable bind. Uvicorn defaults to loopback today,
// but security must not depend on a third-party default staying unchanged.
export const engineServerArgs = (port: string) => [
  "-m",
  "uvicorn",
  "server.app:app",
  "--host",
  "127.0.0.1",
  "--port",
  port,
];

/** Adres silnika BEZ podnoszenia go — dla nasłuchów, które mają czekać, aż
 * silnik pojawi się sam (attach-sync, WS uwagi), a nie go zapalać. */
export function engineBaseUrl(): string {
  const raw = (process.env.ENGINE_URL ?? DEFAULT_URL).replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EngineUnavailableError(`invalid ENGINE_URL: ${raw}`);
  }
  // multibot (G2): harness is the only network boundary. A remote engine URL
  // would bypass its authentication and expose terminal/browser capabilities.
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new EngineUnavailableError("ENGINE_URL must use HTTP loopback (127.0.0.1, localhost, or ::1)");
  }
  return raw;
}

async function healthy(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnEngine(baseUrl: string) {
  const python = enginePython();
  if (!python) {
    throw new EngineUnavailableError(
      `no engine python — dev: cd engine && uv venv .venv --python 3.12 && ` +
        `uv pip install --python ${process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python"} -r requirements.txt` +
        `; spakowana apka: runtime dociąga się sam przy pierwszym starcie ` +
        `(node scripts/provision-engine.mjs --target <dir>)`,
    );
  }
  const port = new URL(baseUrl).port || "8700";
  // Domyślne katalogi danych jak w scripts/dev-engine.mjs — silnik trzyma profile
  // botów obok repo, nie w nim.
  const dataDir = process.env.SLAFY_DATA_DIR ?? defaultEngineDataDir();
  const child = spawn(python, engineServerArgs(port), {
    cwd: ENGINE_DIR,
    // Never inherit a host-level Hermes path. On Windows it defaults to C:\\Users
    // and splits engine profiles from SLAFY_DATA_DIR (gateway then exits 78).
    env: { ...process.env, SLAFY_DATA_DIR: dataDir, HERMES_HOME: dataDir },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log(`[engine] spawned detached (pid ${child.pid}) → ${baseUrl}`);
}

/** Jedno wspólne dojście w locie — N równoległych tur nie odpala N silników. */
let pending: Promise<string> | null = null;

/**
 * Zwraca base URL działającego silnika, podnosząc go w razie potrzeby.
 * Rzuca `EngineUnavailableError`, gdy silnika nie da się mieć — wołający
 * (driver) ma to zamienić w stan "unavailable", nie w wywrotkę harnessu.
 */
export function ensureEngine(): Promise<string> {
  return (pending ??= run().finally(() => {
    pending = null;
  }));
}

async function run(): Promise<string> {
  const external = process.env.ENGINE_URL;
  const baseUrl = engineBaseUrl();

  if (await healthy(baseUrl)) return baseUrl;
  if (external) {
    // Zewnętrznego silnika NIE podnosimy — nie nasz proces, nie nasza maszyna.
    throw new EngineUnavailableError(`no engine at ENGINE_URL=${baseUrl} — start it there first`);
  }

  spawnEngine(baseUrl);
  // Start silnika to import FastAPI + Hermesa — na zimno kilkanaście sekund.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await healthy(baseUrl)) return baseUrl;
  }
  throw new EngineUnavailableError(`engine did not answer ${baseUrl}/health within 60s`);
}

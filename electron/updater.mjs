// In-app auto-updater (electron-updater), manual/button-driven — the same
// shape t3code's desktop app uses: autoDownload off, quitAndInstall on the
// user's "Restart to update" click. One state object is broadcast to the
// renderer on every transition; the renderer just renders it.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import * as electronNs from "electron";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

// W runtime Electrona przestrzeń nazw ma nazwane eksporty (app, ipcMain…) plus
// domyślny równy całemu obiektowi API; w czystym nodzie (self-check
// `node --test electron/updater.test.mjs`) paczka-npm „electron" eksportuje
// wyłącznie ścieżkę binarki jako default. Wybór poniżej działa w obu światach —
// dzięki temu moduł da się testować bez Electrona, a `import { app } from
// "electron"` by się tam w ogóle nie zlinkował.
const electronApi =
  typeof electronNs?.default === "object" && electronNs.default !== null
    ? electronNs.default
    : electronNs;
const { app, ipcMain } = electronApi;
const UPDATE_FEED_URL = "https://github.com/E4B-labs/multibot-desktop-releases/releases/latest/download";
const UPDATE_ERROR_MESSAGE = "Update failed. Check your connection and try again.";

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | error
let state = { status: "idle" };
// stan sprzed rutynowego sprawdzenia w tle — gdy ono polegnie, wracamy do niego,
// żeby nie zgubić np. „available" z wcześniejszego udanego sprawdzenia
let preCheckState = null;
// uchwyt cichej ponowy po nieudanym sprawdzeniu w tle
let quietRetryTimer = null;

function setState(patch, { replace = false } = {}) {
  // replace: pełne przywrócenie stanu (np. po porażce sprawdzenia w tle) —
  // zwykłe doklejenie zostawiłoby pola z poprzedniego stanu (version, percent)
  state = replace ? { ...patch } : { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

// multibot: `background` = rutynowe sprawdzenie (start aplikacji, potem co godzinę).
// Jego porażka NIE pokazuje karty „nieudane" — typowy przypadek to start offline,
// zanim wstanie sieć — tylko cicho wraca do stanu sprzed sprawdzenia i ponawia
// za minutę. Karta błędu zostaje dla kliknięć użytkownika (banner, UpdatesRow).
export function checkNow({ background = false } = {}) {
  if (!autoUpdater) return;
  preCheckState = background ? state : null;
  const before = state;
  try {
    const request = autoUpdater.checkForUpdates();
    // electron-updater reports some failures both through `error` and a
    // rejected Promise. Handle Promise rejection, but do not duplicate an
    // error already processed by event listener.
    if (request && typeof request.catch === "function") {
      void request.catch((e) => {
        if (state === before || state.status === "checking") checkFailed(e);
      });
    }
  } catch (e) {
    checkFailed(e);
  }
}

function checkFailed(e) {
  if (preCheckState && (state.status === "idle" || state.status === "checking")) {
    setState(preCheckState, { replace: true });
    preCheckState = null;
    clearTimeout(quietRetryTimer);
    quietRetryTimer = setTimeout(() => checkNow({ background: true }), 60_000);
    quietRetryTimer.unref?.();
    return;
  }
  preCheckState = null;
  setState({ status: "error", message: UPDATE_ERROR_MESSAGE });
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:app-version", () => app.getVersion());
  // klik użytkownika (banner „Try again", UpdatesRow „Check for updates") —
  // foreground, więc ewentualna porażka jest widoczna jako karta błędu
  ipcMain.handle("update:check", () => checkNow());
  // No local-origin guard here (unlike screen/mic/speech in main.mjs): in C2
  // remote mode the window shows the remote host's page, so the guard just
  // swallowed the user's "Aktualizuj" click. Safe to drop — the update feed is
  // pinned in the main process (public E4B-labs/multibot-desktop-releases, sha512 verified
  // against latest.yml), so the renderer can at most trigger the one
  // legitimate update; it never picks what gets installed.
  ipcMain.handle("update:download", () => {
    if (state.status !== "available") return;
    try {
      const request = autoUpdater?.downloadUpdate();
      if (request && typeof request.catch === "function") {
        void request.catch(() => setState({ status: "error", message: UPDATE_ERROR_MESSAGE }));
      }
    } catch {
      setState({ status: "error", message: UPDATE_ERROR_MESSAGE });
    }
  });
  ipcMain.handle("update:install", () => {
    if (state.status !== "downloaded") return;
    try {
      // multibot: NIE używamy quitAndInstall — NSIS `--force-run` relanszuje
      // aplikację przez skrót z Menu Start (StartApp → ExecShellAsUser
      // "$launchLink"), co na tej maszynie kończy się oknem „Z tym plikiem nie
      // jest skojarzona aplikacja…” (Kacper, długo). Relaunch robimy sami —
      // i wyprzedzająco ubijamy WSZYSTKIE procesy MultiBot, bo NSIS nie
      // wymieni zablokowanego exe i zostawia częściową instalację (tak
      // się stało z 0.1.106: exe urwany w połowie, „nieprawidłowa aplikacja”).
      const installerPath = autoUpdater?.installerPath;
      const exePath = app.getPath("exe");
      const installDir = path.dirname(exePath);
      if (!installerPath) {
        setState({ status: "downloaded" });
        return;
      }
      // Polecenia ida PLIKIEM, nie lancuchem po `cmd /c`. Powod zmierzony:
      // spawn() escapuje wewnetrzne cudzyslowy po konwencji CRT, wiec
      // `start "" /wait "C:...installer.exe"` docieralo do cmd juz
      // z odwroconymi ukosnikami przed cudzyslowami. cmd takiej konwencji nie
      // zna, bral to za nazwe pliku i nie uruchamial niczego. W pliku .cmd
      // cudzyslowy sa zwykle, a sciezka skryptu jedzie jako osobny argument,
      // ktory spawn cytuje poprawnie (sprawdzone takze dla sciezek ze
      // spacjami). Bez `/s`, bo ono zdejmuje cudzyslowy z tej sciezki.
      const script = buildInstallScript({ installerPath, exePath, installDir });
      const scriptPath = path.join(os.tmpdir(), `multibot-update-${Date.now()}.cmd`);
      fs.writeFileSync(scriptPath, script, "utf8");
      spawn("cmd.exe", ["/d", "/c", scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      setImmediate(() => app.quit());
    } catch {
      // Przy awarii instalacji NIE pokazujemy karty błędu — wracamy do
      // „downloaded", żeby użytkownik mógł ponowić z poziomu Updates.
      setState({ status: "downloaded" });
    }
  });
}

/**
 * Tresc skryptu instalacyjnego. Wydzielone i wyeksportowane, zeby dalo sie to
 * sprawdzic testem bez Electrona — obie usterki, ktore tu naprawiamy, byly
 * niewidoczne w kodzie i widoczne dopiero w zachowaniu.
 *
 * `taskkill` BEZ `/t`: to polecenie biegnie w procesie POTOMNYM MultiBota,
 * wiec zabicie calego drzewa ubijalo takze jego samego. Efekt u uzytkownika:
 * aplikacja znika, instalator nigdy nie startuje, wersja zostaje ta sama
 * (zgloszone przy 0.1.111 -> 0.1.112, potwierdzone eksperymentem). Bez `/t`
 * i tak gina wszystkie procesy o nazwie MultiBot.exe, bo dopasowanie idzie
 * po `/im` — a o to chodzilo: NSIS nie wymieni zablokowanego pliku.
 */
export function buildInstallScript({ installerPath, exePath, installDir }) {
  // NSIS: /D= musi byc OSTATNIM parametrem; sciezka ze spacjami w cudzyslowach.
  const dArg = installDir.includes(" ") ? `/D="${installDir}"` : `/D=${installDir}`;
  return [
    "@echo off",
    "taskkill /f /im MultiBot.exe >nul 2>&1",
    "ping -n 3 127.0.0.1 >nul",
    `start "" /wait "${installerPath}" /S --updated ${dArg}`,
    `start "" "${exePath}"`,
    "",
  ].join("\r\n");
}
export function startUpdater(mainWindow, deps = {}) {
  win = mainWindow;
  // wstrzykiwanie tylko na potrzeby self-checka; produkcyjnie idą wartości domyślne
  const isPackaged = deps.isPackaged ?? app.isPackaged;
  const loadUpdater = deps.loadUpdater ?? (() => require("./vendor/electron-updater.cjs"));
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!isPackaged) {
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = loadUpdater());
  } catch {
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  autoUpdater.autoInstallOnAppQuit = false; // button-driven install
  autoUpdater.logger = null;
  autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });

  autoUpdater.on("checking-for-update", () => setState({ status: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setState({ status: "available", version: info?.version, message: undefined }),
  );
  autoUpdater.on("update-not-available", () => setState({ status: "idle" }));
  autoUpdater.on("download-progress", (p) =>
    setState({ status: "downloading", percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "downloaded", version: info?.version });
  });
  autoUpdater.on("error", (e) => checkFailed(e));

  // multibot: pierwszy check OD RAZU przy starcie — karta z nową wersją ma
  // wskoczyć razem z interfejsem, nie po 15 s czekania jak dotychczas. To
  // sprawdzenie jest rutyną w tle, więc porażka (sieć jeszcze nie wstała)
  // idzie cicho i ponowi się za minutę; dalej co 15 sekund (LEKKO — Kacper):
  // latest.yml to 359 B, więc tuczenie kanału jest pomijalne.
  checkNow({ background: true });
  setInterval(() => checkNow({ background: true }), 15_000).unref?.();
}

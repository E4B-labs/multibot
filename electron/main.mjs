import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session, shell, systemPreferences, utilityProcess } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { addRemoteHost, getActiveId, listRemoteHosts, removeHost, resolveLoadTarget, setActiveHost } from "./hosts.mjs";
import { isLocalSender } from "./local-origin.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// multibot (G6): Task Scheduler starts packaged app without a window. Electron
// supplies Node + bundled harness/UI, so clean Windows needs no Node or pnpm.
const SERVER_ONLY = process.argv.includes("--server-only");
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
// multibot (C2): the main window, kept so the host picker and IPC handlers
// can retarget it without tearing it down. The picker is a separate small
// window, opened on demand — it never replaces the harness UI window.
let mainWindow = null;
let pickerWindow = null;
// multibot: runtime silnika (Python + Hermes + przeglądarka Playwrighta) NIE
// jedzie w instalatorze — dociąga go scripts/provision-engine.mjs do userData
// przy pierwszym starcie. Ten sam układ katalogów zna server/engine/supervisor.ts.
const ENGINE_RUNTIME = path.join(app.getPath("userData"), "engine-runtime");
const ENGINE_DATA = path.join(app.getPath("userData"), "engine-data");

function localAccessTokenFragment() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openmausbot", "config.json"), "utf8"));
    const token = String(config?.auth?.token ?? "").trim();
    return token ? `#access_token=${encodeURIComponent(token)}` : "";
  } catch {
    return "";
  }
}

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_HOST: "127.0.0.1", // Tailscale Serve terminates HTTPS on loopback.
      OMB_PORT: String(port),
      // Silnik dziedziczy to przez spawn w supervisorze. PLAYWRIGHT_BROWSERS_PATH
      // musi tu być: domyślny katalog przeglądarek leży na dysku systemowym,
      // a provisioner instaluje je pod userData.
      OMB_ENGINE_RUNTIME: ENGINE_RUNTIME,
      SLAFY_DATA_DIR: process.env.SLAFY_DATA_DIR ?? ENGINE_DATA,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(ENGINE_RUNTIME, "browsers"),
      // Trusted packaged path; used only after explicit onboarding 24/7 choice.
      OMB_PACKAGED_EXE: app.isPackaged && process.platform === "win32" ? process.execPath : "",
      OMB_SERVER_SERVICE: SERVER_ONLY ? "1" : "",
    },
    stdio: "inherit",
  });
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "multibot" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      // A server-only ONLOGON task deliberately outlives desktop UI. Reuse only
      // an explicit service marker; never trust an arbitrary dev harness.
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        const body = res.ok ? await res.json() : null;
        if (body?.app === "multibot" && body?.static === true && body?.service === true) {
          serverProc = null;
          SERVER_PORT = port;
          return true;
        }
      } catch {
        /* no installed service on this port */
      }
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

function provisionEngineRuntime() {
  if (fs.existsSync(path.join(ENGINE_RUNTIME, ".provisioned"))) return Promise.resolve();
  const script = path.join(process.resourcesPath, "provision-engine.mjs");
  const proc = utilityProcess.fork(
    script,
    ["--target", ENGINE_RUNTIME, "--requirements", path.join(process.resourcesPath, "engine", "requirements.txt")],
    { stdio: "inherit" },
  );
  return new Promise((resolve, reject) => {
    proc.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`provisioning exit ${code}`))));
  });
}

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">◈</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen MultiBot — if it keeps happening, restart your device.</p></div></body>`,
  );

// multibot (C2): fragment credential hand-off, same trick as
// localAccessTokenFragment() below but for a remote host's token instead of
// the local ~/.openmausbot one. Never reaches HTTP — src/lib/auth.ts's
// bootstrapLocalAuthToken() reads window.location.hash client-side, stores
// it, and erases it before first paint.
function remoteFragment(token) {
  return token ? `#access_token=${encodeURIComponent(token)}` : "";
}

/** Decides what `win` should load: a saved remote host, or the existing
 * local flow (packaged server / dev vite), completely unchanged when no
 * remote host is active. */
function loadActiveTarget(win) {
  const target = resolveLoadTarget();
  if (target.mode === "remote") {
    win.loadURL(`${target.url}/${remoteFragment(target.token)}`);
    return;
  }
  if (app.isPackaged) {
    // Fragment never reaches HTTP. Renderer stores it, then erases URL before
    // first paint, so fresh packaged installs do not deadlock on login.
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}/${localAccessTokenFragment()}` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  loadActiveTarget(win);
  return win;
}

// multibot (C2): small native window for switching between the local
// harness and a saved remote host. Separate from the harness UI itself
// (that's src/components/ territory) — this window only ever shows
// electron/host-picker.html, never a remote origin.
function openHostPicker() {
  if (pickerWindow) {
    pickerWindow.focus();
    return;
  }
  pickerWindow = new BrowserWindow({
    width: 480,
    height: 640,
    parent: mainWindow ?? undefined,
    icon: APP_ICON,
    backgroundColor: "#070707",
    title: "MultiBot — Host",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "host-picker-preload.cjs"),
    },
  });
  pickerWindow.setMenuBarVisibility(false);
  void pickerWindow.loadFile(path.join(__dirname, "host-picker.html"));
  pickerWindow.on("closed", () => {
    pickerWindow = null;
  });
}

// Role-based template: `appMenu`/`editMenu`/`windowMenu` are Electron's
// built-in menus and already carry the standard items (Copy/Paste/Quit/…) —
// building a custom menu without them silently breaks clipboard shortcuts,
// which is why this reuses the roles instead of listing items by hand.
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Host",
      submenu: [{ label: "Switch Host…", accelerator: "CmdOrCtrl+Shift+H", click: () => openHostPicker() }],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server.
// C2 remote mode: the window can show an arbitrary host's page, so this
// (and speech:start, perm:request-mic below) must refuse anything not from
// our own local origin — see electron/local-origin.mjs.
ipcMain.handle("screen:frame", async (event) => {
  if (!isLocalSender(event)) return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
ipcMain.handle("perm:status", () => ({
  mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
}));
ipcMain.handle("perm:request-mic", async (event) => {
  if (!isLocalSender(event)) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
  };
  return shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
  );
});

ipcMain.handle("speech:start", (event) => {
  if (!isLocalSender(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

// multibot (C2): host switching for the picker window (electron/hosts.mjs
// owns persistence + safeStorage encryption).
ipcMain.handle("hosts:list", () => ({ activeId: getActiveId(), hosts: listRemoteHosts() }));
ipcMain.handle("hosts:add-remote", (_event, host) => addRemoteHost(host ?? {}));
ipcMain.handle("hosts:remove", (_event, id) => removeHost(id));
ipcMain.handle("hosts:use-local", () => {
  setActiveHost("local");
  if (mainWindow) loadActiveTarget(mainWindow);
});
ipcMain.handle("hosts:use-host", (_event, id) => {
  setActiveHost(id);
  if (mainWindow) loadActiveTarget(mainWindow);
});
// Seam: server/firebase-auth.ts has no loopback-capable HTTP route yet (see
// electron/oauth-loopback.mjs for the reusable receiver, unused until then).
ipcMain.handle("hosts:begin-browser-login", () => {
  throw new Error("Browser sign-in isn't available yet — no Firebase project is configured. Paste the access token instead.");
});

app.whenReady().then(async () => {
  if (SERVER_ONLY) {
    if (!app.isPackaged) {
      console.error("--server-only requires packaged app");
      return app.exit(1);
    }
    // Explicit server install may take minutes on first boot; no GUI or UAC.
    try {
      await provisionEngineRuntime();
    } catch (e) {
      console.error("[engine] provisioning failed:", e);
      app.exit(1);
      return;
    }
    serverReady = await startServerPackaged();
    if (!serverReady) app.exit(1);
    return;
  }
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  buildAppMenu();
  registerCuaIpc();
  registerUpdaterIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  startCua().catch((e) => console.error("[cua] start failed:", e));
  // multibot (G3): provisioning starts only after the onboarding 24/7 choice;
  // the authenticated harness endpoint runs the same bundled script.
  if (app.isPackaged) serverReady = await startServerPackaged();
  const win = createWindow();
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!SERVER_ONLY && process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  stopCua().finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});

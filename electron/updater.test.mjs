// Self-check dla updater.mjs. Zero zależności:
// `node --test electron/updater.test.mjs`.
//
// Pilnuje zmiany „karta aktualizacji od razu po starcie": pierwsze sprawdzenie
// ma ruszać natychmiast (nie po 15 s), a porażka RUTYNOWEGO sprawdzenia
// (start offline, chwilowy brak sieci) nie może pokazać karty błędu — wraca
// do stanu sprzed sprawdzenia i cicho ponawia. Porażka sprawdzenia z kliknięcia
// użytkownika kartę błędu pokazuje dalej.
//
// Moduł trzyma stan w zmiennych modułowych, więc każdy test importuje świeżą
// kopię przez query string (bust cache ESM). Atrapa autoUpdatera to zwykły
// EventEmitter — żadnego Electrona, sieci ani dysku.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

let caseNo = 0;
async function freshModule() {
  return import(`./updater.mjs?case=${++caseNo}`);
}

/** Atrapa okna: zbiera wszystko, co updater rozgłasza do renderera. */
function fakeWindow() {
  const sent = [];
  return {
    sent,
    webContents: { send: (_channel, s) => sent.push(s) },
  };
}

/** Atrapa vendored electron-updatera: liczy checki, zdarzenia puszcza ręcznie. */
function fakeUpdater() {
  const emitter = new EventEmitter();
  const autoUpdater = Object.assign(emitter, {
    checks: 0,
    feed: null,
    setFeedURL(feed) {
      this.feed = feed;
    },
    checkForUpdates() {
      this.checks += 1;
    },
    downloadUpdate() {},
    quitAndInstall() {},
  });
  return autoUpdater;
}

test("pierwsze sprawdzenie rusza od razu przy starcie, nie po 15 s", async () => {
  const { startUpdater } = await freshModule();
  const fake = fakeUpdater();
  const win = fakeWindow();
  startUpdater(win, { isPackaged: true, loadUpdater: () => ({ autoUpdater: fake }) });
  // bez czekania, w tym samym ticku: check już się odbył
  assert.equal(fake.checks, 1);
  assert.deepEqual(fake.feed, {
    provider: "generic",
    url: "https://github.com/E4B-labs/multibot-releases/releases/latest/download",
  });
});

test("apka niedopakowana zostaje uśpiona — zero checków", async () => {
  const { startUpdater } = await freshModule();
  const fake = fakeUpdater();
  const win = fakeWindow();
  startUpdater(win, { isPackaged: false, loadUpdater: () => ({ autoUpdater: fake }) });
  assert.equal(fake.checks, 0);
});

test("porażka rutynowego sprawdzenia nie daje karty błędu i przywraca stan sprzed", async () => {
  const { startUpdater, checkNow } = await freshModule();
  const fake = fakeUpdater();
  const win = fakeWindow();
  startUpdater(win, { isPackaged: true, loadUpdater: () => ({ autoUpdater: fake }) });

  fake.emit("checking-for-update");
  fake.emit("update-available", { version: "0.1.43" });
  checkNow({ background: true }); // godzinna rutyna — przez ten sam kanał co start
  fake.emit("checking-for-update");
  fake.emit("error", new Error("ENOTFOUND releases.github.com"));

  const last = win.sent.at(-1);
  assert.equal(last.status, "available", `oczekiwano powrotu do „available", było: ${JSON.stringify(last)}`);
  assert.equal(last.version, "0.1.43");
});

test("porażka z kliknięcia pokazuje krótki błąd bez nagłówków i cookies", async () => {
  const { startUpdater, checkNow } = await freshModule();
  const fake = fakeUpdater();
  const win = fakeWindow();
  startUpdater(win, { isPackaged: true, loadUpdater: () => ({ autoUpdater: fake }) });

  fake.emit("checking-for-update");
  checkNow(); // foreground — jak klik w UpdatesRow
  fake.emit("error", new Error("404 Headers: { set-cookie: secret; authorization: Bearer secret }"));

  const last = win.sent.at(-1);
  assert.equal(last.status, "error");
  assert.equal(last.message, "Update failed. Check your connection and try again.");
  assert.doesNotMatch(last.message, /cookie|authorization|secret/i);
});

test("po udanym sprawdzeniu bez aktualizacji wraca idle i karta milczy", async () => {
  const { startUpdater } = await freshModule();
  const fake = fakeUpdater();
  const win = fakeWindow();
  startUpdater(win, { isPackaged: true, loadUpdater: () => ({ autoUpdater: fake }) });

  fake.emit("checking-for-update");
  fake.emit("update-not-available");

  const last = win.sent.at(-1);
  assert.equal(last.status, "idle");
});

test("pobranie aktualizacji nie zamyka aplikacji automatycznie", async () => {
  const { startUpdater } = await freshModule();
  const fake = fakeUpdater();
  let installs = 0;
  fake.quitAndInstall = () => { installs += 1; };
  const win = fakeWindow();
  startUpdater(win, { isPackaged: true, loadUpdater: () => ({ autoUpdater: fake }) });
  fake.emit("update-available", { version: "0.1.97" });
  fake.emit("update-downloaded", { version: "0.1.97" });
  assert.equal(installs, 0);
  assert.equal(win.sent.at(-1).status, "downloaded");
});

// multibot: skrypt instalacyjny. Obie usterki poniżej wyłożyły aktualizację
// 0.1.111 → 0.1.112 u Kacpra: aplikacja znikała, instalator nie startował,
// wersja zostawała ta sama. Żadnej z nich nie widać w kodzie — widać je
// dopiero w zachowaniu, więc pilnujemy ich tutaj.
test("taskkill leci BEZ /t — inaczej ubija sam siebie", async () => {
  const { buildInstallScript } = await freshModule();
  const script = buildInstallScript({
    installerPath: "C:\Users\k\AppData\Local\multibot-updater\installer.exe",
    exePath: "C:\Users\k\AppData\Local\Programs\MultiBot\MultiBot.exe",
    installDir: "C:\Users\k\AppData\Local\Programs\MultiBot",
  });
  const kill = script.split("\r\n").find((l) => l.startsWith("taskkill"));
  assert.ok(kill, "brak polecenia taskkill");
  // `/t` zabija drzewo procesów MultiBota, a skrypt jest jego potomkiem
  assert.ok(!/\s\/t(\s|$)/.test(kill), `taskkill nie może mieć /t: ${kill}`);
  assert.match(kill, /\/im MultiBot\.exe/);
});

test("ścieżki są cytowane, a /D= zostaje na końcu wiersza", async () => {
  const { buildInstallScript } = await freshModule();
  const script = buildInstallScript({
    installerPath: "C:\cache\installer.exe",
    exePath: "C:\Programy\MultiBot\MultiBot.exe",
    installDir: "C:\Programy\MultiBot",
  });
  const run = script.split("\r\n").find((l) => l.includes("installer.exe"));
  assert.ok(run.includes('"C:\cache\installer.exe"'), `ścieżka bez cudzysłowów: ${run}`);
  assert.ok(run.trimEnd().endsWith("/D=C:\Programy\MultiBot"), `/D= musi kończyć wiersz: ${run}`);
  assert.ok(script.includes('start "" "C:\Programy\MultiBot\MultiBot.exe"'), "brak relanszu aplikacji");
});

test("katalog ze spacjami dostaje /D= w cudzysłowach", async () => {
  const { buildInstallScript } = await freshModule();
  const script = buildInstallScript({
    installerPath: "C:\cache\installer.exe",
    exePath: "C:\Program Files\MultiBot\MultiBot.exe",
    installDir: "C:\Program Files\MultiBot",
  });
  assert.ok(script.includes('/D="C:\Program Files\MultiBot"'), "spacje wymagają cudzysłowów");
});

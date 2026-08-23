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

test("porażka sprawdzenia z kliknięcia użytkownika pokazuje kartę błędu", async () => {
  const { startUpdater, checkNow } = await freshModule();
  const fake = fakeUpdater();
  const win = fakeWindow();
  startUpdater(win, { isPackaged: true, loadUpdater: () => ({ autoUpdater: fake }) });

  fake.emit("checking-for-update");
  checkNow(); // foreground — jak klik w UpdatesRow
  fake.emit("error", new Error("boom"));

  const last = win.sent.at(-1);
  assert.equal(last.status, "error");
  assert.match(last.message, /boom/);
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

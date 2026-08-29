// Trwałe przechowywanie tokenu dostępu użytkownika po stronie głównego
// procesu. localStorage renderera pod Electronem bywa czyszczony przy
// wymuszonym zamknięciu (np. przez skrypt instalatora aktualizacji), więc
// token, którym użytkownik się raz zalogował, musi leżeć na dysku — wtedy
// main.mjs może go wstrzyknąć w fragmencie URL przy każdym starcie i ekran
// logowania nie wyskakuje przy każdym uruchomieniu.
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";

const TOKEN_FILE = "auth-token.json";
const ACCOUNT_TOKEN_FILE = "auth-account-token.json";

function tokenFile() {
  return path.join(app.getPath("userData"), TOKEN_FILE);
}

function accountTokenFile() {
  return path.join(app.getPath("userData"), ACCOUNT_TOKEN_FILE);
}

export function loadPersistedToken() {
  try {
    const raw = fs.readFileSync(tokenFile(), "utf8");
    const token = String(JSON.parse(raw)?.token ?? "").trim();
    return token || null;
  } catch {
    return null;
  }
}

export function savePersistedToken(token) {
  const file = tokenFile();
  const value = String(token ?? "").trim();
  if (!value) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* brak pliku — OK */
    }
    return;
  }
  // Zapis przez plik tymczasowy i rename (jak app-prefs.json), żeby ubice
  // procesu w połowie zapisu nie zostawiło uciętego JSON-a.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token: value }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// multibot: token konta użytkownika — trzymany osobno od master tokena, żeby
// nie pytać o login przy każdym starcie. Ten sam schemat: tmp + rename, 0600.
export function loadPersistedAccountToken() {
  try {
    const raw = fs.readFileSync(accountTokenFile(), "utf8");
    const token = String(JSON.parse(raw)?.token ?? "").trim();
    return token || null;
  } catch {
    return null;
  }
}

export function savePersistedAccountToken(token) {
  const file = accountTokenFile();
  const value = String(token ?? "").trim();
  if (!value) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* brak pliku — OK */
    }
    return;
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token: value }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearPersistedAccountToken() {
  savePersistedAccountToken("");
}

export function registerAuthIpc() {
  ipcMain.handle("auth:load-token", () => loadPersistedToken());
  ipcMain.handle("auth:save-token", (_event, token) => {
    savePersistedToken(token);
    return true;
  });
  ipcMain.handle("auth:clear-token", () => {
    savePersistedToken("");
    return true;
  });
  ipcMain.handle("auth:load-account-token", () => loadPersistedAccountToken());
  ipcMain.handle("auth:save-account-token", (_event, token) => {
    savePersistedAccountToken(token);
    return true;
  });
  ipcMain.handle("auth:clear-account-token", () => {
    clearPersistedAccountToken();
    return true;
  });
}

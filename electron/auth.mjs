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

function tokenFile() {
  return path.join(app.getPath("userData"), TOKEN_FILE);
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
}

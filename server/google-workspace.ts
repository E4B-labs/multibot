// multibot (Google Workspace): preset samohostowanego serwera MCP workspace-mcp
// (PyPI `workspace-mcp`, taylorwilsdon/google_workspace_mcp) — Gmail, Drive,
// Calendar i reszta pakietu Google przez JEDEN stdio serwer z venvu silnika.
//
// Cel: zero nowej warstwy MCP. Konektor ląduje w istniejącym rejestrze
// `mcpConnectors` (saveConnector), więc rozprowadzanie działa bez zmian:
// CLI boty przez mcpServers() → --mcp-config, boty silnika przez syncConnectors
// → /api/plugins/install (mb-google-workspace).
//
// OAuth jest LLM-driven i nie wymaga plumbingu po naszej stronie: wywołanie
// narzędzia bez tokena zwraca tekst "ACTION REQUIRED: Google Authentication
// Needed" + Authorization URL — bot pokazuje URL w czacie, użytkownik klika,
// Google wraca na localhost:8000 (callback server wstaje leniwie w procesie
// serwera), a token ląduje we WSPÓLNYM katalogu credentials. Wszystkie boty na
// hoście dzielą ten sam token (--single-user czyta dowolne credentials z
// katalogu) — jeden login dla całej floty.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { augmentedPath } from "./env-path.ts";
import { connectors, saveConnector } from "./mcp-connectors.ts";

export const GOOGLE_WORKSPACE_ID = "google-workspace";
export const GOOGLE_WORKSPACE_NAME = "Google Workspace";

/** Konsolowy skrypt `workspace-mcp`. Mieszkał w venvie silnika Hermesa; po jego
 * usunięciu szukamy go na PATH (ta sama ścieżka, którą widzą pozostałe CLI —
 * `augmentedPath`), więc liczy się każda instalacja: pipx, pip --user, venv
 * dodany do PATH. Nie znaleziony → sama nazwa, a `workspaceMcpInstalled()`
 * mówi UI, że trzeba go doinstalować. */
export function workspaceMcpBin(): string {
  const name = process.platform === "win32" ? "workspace-mcp.exe" : "workspace-mcp";
  const found = augmentedPath()
    .split(process.platform === "win32" ? ";" : ":")
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate));
  return found ?? name;
}

export function workspaceMcpInstalled(): boolean {
  return workspaceMcpBin() !== (process.platform === "win32" ? "workspace-mcp.exe" : "workspace-mcp");
}

/** Wspólny katalog tokenów Google — override env, domyślnie przy configu harnessa. */
export function credentialsDir(): string {
  return (
    process.env.WORKSPACE_MCP_CREDENTIALS_DIR ??
    join(homedir(), ".openmausbot", "google-workspace-credentials")
  );
}

/** Token = niepusty katalog credentials (workspace-mcp zapisuje plik per konto). */
export function googleWorkspaceConnected(): boolean {
  try {
    return readdirSync(credentialsDir()).some((f) => !f.startsWith("."));
  } catch {
    return false;
  }
}

/** Pełny wsad konektora do saveConnector — ścieżki hostu liczy serwer, nie UI. */
export function googleWorkspaceSpec(clientId: string, clientSecret: string) {
  return {
    name: GOOGLE_WORKSPACE_NAME,
    transport: {
      type: "stdio" as const,
      command: workspaceMcpBin(),
      args: ["--single-user", "--tool-tier", "complete"],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: clientId,
        GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
        WORKSPACE_MCP_CREDENTIALS_DIR: credentialsDir(),
      },
    },
  };
}

export function saveGoogleWorkspace(clientId: string, clientSecret: string) {
  if (!clientId.trim() || !clientSecret.trim()) {
    throw new Error("google workspace: clientId and clientSecret are required");
  }
  return saveConnector(GOOGLE_WORKSPACE_ID, googleWorkspaceSpec(clientId.trim(), clientSecret.trim()));
}

/** Wyloguj = skasuj wspólne tokeny (konektor zostaje, re-login przy użyciu). */
export function resetGoogleWorkspaceCredentials(): void {
  rmSync(credentialsDir(), { recursive: true, force: true });
}

export function googleWorkspaceStatus() {
  const connector = connectors().find((c) => c.id === GOOGLE_WORKSPACE_ID);
  return {
    installed: workspaceMcpInstalled(),
    configured: Boolean(connector),
    connected: googleWorkspaceConnected(),
    installHint: installHint(),
  };
}

/** Komenda do wklejenia w terminalu hosta, gdy workspace-mcp brakuje. `pipx`
 * daje własny venv i wystawia skrypt na PATH — dokładnie to, czego szuka
 * `workspaceMcpBin()`. */
export function installHint(): string {
  return "pipx install workspace-mcp";
}

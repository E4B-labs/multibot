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
import { dirname, join } from "node:path";
import { venvPython } from "./engine/supervisor.ts";
import { connectors, saveConnector } from "./mcp-connectors.ts";

export const GOOGLE_WORKSPACE_ID = "google-workspace";
export const GOOGLE_WORKSPACE_NAME = "Google Workspace";

/** Konsolowy skrypt `workspace-mcp` z venvu silnika (dirname pythona = bin/Scripts). */
export function workspaceMcpBin(engineDir?: string): string {
  const dir = dirname(venvPython(engineDir));
  return process.platform === "win32" ? join(dir, "workspace-mcp.exe") : join(dir, "workspace-mcp");
}

export function workspaceMcpInstalled(): boolean {
  return existsSync(workspaceMcpBin());
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

/** Komenda do wklejenia w terminalu hosta, gdy workspace-mcp brakuje. */
export function installHint(): string {
  const pip = join(dirname(venvPython()), process.platform === "win32" ? "pip.exe" : "pip");
  return `${pip} install workspace-mcp`;
}

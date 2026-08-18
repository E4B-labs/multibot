// multibot (Google Workspace): preset konektora — spec, status, wylogowanie.
// Ścieżki venvu per-platform są nieprzewidywalne w teście, więc testujemy
// kształt specu (env, args, tier) i logikę connected na katalogu tymczasowym;
// same bin-path testujemy tylko przez GS path override.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_ID,
  credentialsDir,
  googleWorkspaceConnected,
  googleWorkspaceSpec,
  resetGoogleWorkspaceCredentials,
  saveGoogleWorkspace,
} from "./google-workspace.ts";
import { removeConnector } from "./mcp-connectors.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-"));
  process.env.WORKSPACE_MCP_CREDENTIALS_DIR = dir;
});
afterEach(() => {
  delete process.env.WORKSPACE_MCP_CREDENTIALS_DIR;
  rmSync(dir, { recursive: true, force: true });
  removeConnector(GOOGLE_WORKSPACE_ID);
});

describe("googleWorkspaceSpec", () => {
  it("builds a stdio connector with shared credentials dir and complete tier", () => {
    const raw = googleWorkspaceSpec("id-123", "secret-456");
    expect(raw.name).toBe("Google Workspace");
    const t = raw.transport as Extract<typeof raw.transport, { type: "stdio" }>;
    expect(t.type).toBe("stdio");
    expect(t.args).toEqual(["--single-user", "--tool-tier", "complete"]);
    expect(t.env?.GOOGLE_OAUTH_CLIENT_ID).toBe("id-123");
    expect(t.env?.GOOGLE_OAUTH_CLIENT_SECRET).toBe("secret-456");
    expect(t.env?.WORKSPACE_MCP_CREDENTIALS_DIR).toBe(credentialsDir());
    // command wskazuje bin venvu silnika, nie gołego `workspace-mcp` z PATH
    expect(t.command).toMatch(/workspace-mcp(\.exe)?$/);
  });
});

describe("connected", () => {
  it("false on empty dir, true once a token file lands", () => {
    expect(googleWorkspaceConnected()).toBe(false);
    writeFileSync(join(dir, "user@gmail.com.json"), "{}");
    expect(googleWorkspaceConnected()).toBe(true);
    resetGoogleWorkspaceCredentials();
    expect(googleWorkspaceConnected()).toBe(false);
  });
});

describe("saveGoogleWorkspace", () => {
  it("saves under the reserved-ish preset id and rejects empty creds", () => {
    const connector = saveGoogleWorkspace(" id-123 ", "secret-456");
    expect(connector.id).toBe(GOOGLE_WORKSPACE_ID);
    expect(() => saveGoogleWorkspace(" ", "x")).toThrow();
  });
});

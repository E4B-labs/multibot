// multibot (A2): wyliczenie narzędzi w prompcie musi być mirrorem prawdziwych
// serwerów — stąd testy czytające oba źródła z dysku (ten sam wzorzec, co test
// CURSOR_COLORS w server/engine/computer-mcp.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AGENTS_MCP_TOOLS, COMPUTER_MCP_TOOLS, turnToolsText } from "./turn-tools.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

describe("turnToolsText", () => {
  it("enumerates computer tools when the computer is mounted", () => {
    const text = turnToolsText({ localComputer: { command: "py" } } as any);
    expect(text).toContain("Computer MCP tools this turn");
    expect(text).toContain("screenshot");
    expect(text).toContain("computer_exec");
    expect(text).not.toContain("Agents/workspace");
  });

  it("enumerates agents tools when the agents server is mounted", () => {
    const text = turnToolsText({ agents: { command: "node" } } as any);
    expect(text).toContain("Agents/workspace MCP tools this turn");
    expect(text).toContain("list_bots");
    expect(text).toContain("get_device_info");
    expect(text).not.toContain("Computer MCP");
  });

  // Regresja: bot dostawał `send_file` jako jedną z dwudziestu czterech nazw
  // w liście i po nią nie sięgał — zapisywał plik i oddawał użytkownikowi samą
  // ścieżkę. Zdanie o dostarczaniu ma być OBOK listy, nie w niej.
  it("tells the bot that a path is not delivery", () => {
    const text = turnToolsText({ agents: { command: "node" } } as any);
    expect(text).toContain("send_file");
    expect(text).toContain("NOT delivery");
  });

  it("says plainly when nothing is mounted", () => {
    const text = turnToolsText({} as any);
    expect(text).toContain("No MCP tools are mounted this turn");
  });

  it("returns empty text for an undefined integrations object", () => {
    expect(turnToolsText(undefined)).toBe("");
  });

  it("mentions composio when present", () => {
    const text = turnToolsText({ composio: { key: "k" } } as any);
    expect(text).toContain("Composio");
  });
});

describe("tool lists mirror their servers", () => {
  it("AGENTS_MCP_TOOLS matches TOOLS in agents-proxy.ts", () => {
    const src = readFileSync(join(SERVER_DIR, "drivers", "agents-proxy.ts"), "utf8");
    const fromSource = [...src.matchAll(/name:\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
    expect(fromSource.length).toBeGreaterThan(10);
    expect([...AGENTS_MCP_TOOLS].sort()).toEqual([...fromSource].sort());
  });

  it("COMPUTER_MCP_TOOLS matches @mcp.tool() functions in computer_mcp.py", () => {
    const py = join(SERVER_DIR, "..", "engine", "server", "computer_mcp.py");
    const src = readFileSync(py, "utf8");
    const fromSource = [...src.matchAll(/@mcp\.tool\(\)\s*\nasync def ([a-z_0-9]+)\(/g)].map((m) => m[1]);
    expect(fromSource.length).toBeGreaterThan(5);
    expect([...COMPUTER_MCP_TOOLS].sort()).toEqual([...fromSource].sort());
  });
});
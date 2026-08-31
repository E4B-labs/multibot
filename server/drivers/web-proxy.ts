// Minimal stdio MCP server exposing the provider-neutral web registry.
// It is intentionally dependency-free so Claude/ACP/Codex can mount it in
// exactly the same way on Windows, Linux and Termux.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { executeWebTool, WEB_TOOL_DEFINITIONS } from "../web-tools.ts";

const tools = WEB_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
}));

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function error(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function startWebProxy(): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    return reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "multibot-web", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") return reply(message.id, { tools });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments;
    void executeWebTool(name, args && typeof args === "object" ? args : {}).then(
      (text) => reply(message.id, { content: [{ type: "text", text }], isError: false }),
      (cause) => reply(message.id, { content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }], isError: true }),
    );
    return;
  }
  if (message.id !== undefined) error(message.id, -32601, `method not found: ${String(message.method)}`);
  });
}

// The file is also imported by the harness to build an MCP spawn spec. Never
// attach a stdin listener to the long-running HTTP server in that case.
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1].replace(/\\/g, "/")}`))) {
  startWebProxy();
}

export function webMcpIntegration(): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: [fileURLToPath(import.meta.url)], env: {} };
}

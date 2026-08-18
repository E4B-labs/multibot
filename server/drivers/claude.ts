// Claude driver — stream-json both directions. One worker stays alive per
// bot, so Termux/proot and MCP handshakes happen once instead of per turn.
//
// Integrations become MCP servers on the CLI:
//   - Composio Connect (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "../config.ts";
import { augmentedPath, resolveCliSpawn } from "../env-path.ts";
// multibot (F7): wspólny montaż mcpServers (Composio + własne konektory).
import { mcpServers as buildMcpServers } from "../mcp-servers.ts";
import { killTree } from "../kill-tree.ts";
import { approvalRule } from "../approval-rules.ts";
import { approvalRuleAllowed, autoApproveAllowed, canUseIntegration, toolAllowed, turnPolicy } from "../turn-policy.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
}

// model catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
};

// UI keeps stable product names; Claude Code receives official model IDs.
const canonicalModel = (model: string | undefined) => {
  if (!model || model === "sonnet" || model.startsWith("claude-sonnet-")) return "claude-sonnet-5";
  if (model === "opus" || model.startsWith("claude-opus-")) return "claude-opus-5";
  if (model === "haiku" || model.startsWith("claude-haiku-")) return "claude-haiku-4-5";
  if (model === "fable" || model.startsWith("claude-fable-")) return "claude-fable-5";
  return model;
};
const cliModel = (model: string | undefined) => {
  return canonicalModel(model);
};

const WORKER_IDLE_MS = 10 * 60_000;

// proxy entry files live next to this one as .ts in dev (node type
// stripping) and .js in the compiled dist-server the packaged app ships
const proxyPath = (basename: string) => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "..", `${basename}.ts`);
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
};
const PROXY_PATH = proxyPath("computer-proxy");
const PERM_PROXY_PATH = proxyPath("permission-proxy");
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note; unanswered questions
// answer with "use your best judgment" — guidance, never a block.
interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  at: number;
}

const DENY_TIMEOUT_NOTE =
  "MultiBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "MultiBot: nobody answered in time. Use your best judgment and continue.";
const QUESTION_DISMISS_NOTE = "MultiBot: the user closed the question without answering. Use your best judgment and continue.";

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.url === "string") return input.url.slice(0, 200);
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text.slice(0, 200);
}

export function permissionSocketPath(threadId: string) {
  const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
  // multibot: Windows has no unix sockets — net.createServer binds a named
  // pipe instead, same API on both ends. The pipe namespace is global and
  // flat (DATA_DIR does not isolate it), so the pid keeps concurrent
  // harnesses off each other's names.
  if (process.platform === "win32") return `\\\\.\\pipe\\omb-perm-${process.pid}-${tag}`;
  return join(DATA_DIR, `perm-${tag}.sock`);
}

function createPermissionBroker(opts: {
  socketPath: string;
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: string; source: string }) => void;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<string, { ask: Ask; finish: (behavior: string, message: string | undefined, source: string) => void }>();
  try {
    unlinkSync(opts.socketPath);
  } catch {}
  const server = createNetServer((conn) => {
    conn.on("error", () => {});
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        const ask: Ask = {
          id: askId,
          kind,
          tool: msg.tool ?? "tool",
          input: msg.input ?? {},
          suggestions: Array.isArray(msg.suggestions) ? msg.suggestions : undefined,
          at: Date.now(),
        };
        const finish = (behavior: string, message: string | undefined, source: string) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message }) + "\n");
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  });
  // multibot: a broker that never came up used to be silent — every
  // approval then timed out into a deny nobody could explain. Say so.
  server.on("error", (e) => {
    console.error(`permission broker unavailable on ${opts.socketPath}: ${(e as Error).message}`);
  });
  server.listen(opts.socketPath);
  return {
    answer(askId: string, behavior: string, message?: string): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      // multibot: pytanie ma tylko jedną formę odpowiedzi — treść. Zamknięcie
      // karty krzyżykiem przychodzi jako "deny" i wypadało tu na `false`: ask
      // zostawał w `pending`, karta znikała z czatu, a bot wisiał do
      // 15-minutowego timeoutu i sam sobie dopisywał odpowiedź. Każde
      // rozstrzygnięcie pytania kończymy więc jako odpowiedź.
      if (p.ask.kind === "question") {
        p.finish("answer", message ?? QUESTION_DISMISS_NOTE, "user");
        return true;
      }
      if (!["allow", "always", "deny"].includes(behavior)) return false;
      p.finish(behavior, message, "user");
      return true;
    },
    close() {
      for (const p of [...pending.values()]) {
        if (p.ask.kind === "question") p.finish("answer", "MultiBot: the turn is ending — wrap up.", "shutdown");
        else p.finish("deny", "MultiBot: the turn ended", "shutdown");
      }
      try {
        server.close();
      } catch {}
      try {
        unlinkSync(opts.socketPath);
      } catch {}
    },
  };
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    type Broker = ReturnType<typeof createPermissionBroker>;
    type Turn = { turnId: string; broker?: Broker; settled: boolean; sawStreamDelta: boolean };
    type Worker = {
      child: ReturnType<typeof spawn>;
      signature: string;
      sessionId: string | null;
      broker?: Broker;
      current?: Turn;
      buffer: string;
      stderr: string;
      idleTimer?: ReturnType<typeof setTimeout>;
      onLine?: (line: string) => void;
      finish?: (ok: boolean, stopReason: string | null, cost?: number | null) => void;
    };
    // One active turn per thread; workers survive completed turns. The CLI
    // itself owns conversation state, so --resume is only needed after a
    // worker restart.
    const active = new Map<string, { stop: () => void; turnId: string; broker?: Broker }>();
    const workers = new Map<string, Worker>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const policy = turnPolicy(threadId);
      const turnId = newId();
      const selectedModel = cliModel(turn.model);
      const requestedReasoning = (turn as SendTurnInput & { reasoning?: string }).reasoning;
      const permissionMode = policy ? "default" : config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode;
      const socketPath = permissionSocketPath(threadId);
      const args = [
        "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
        "--include-partial-messages", "--permission-mode", permissionMode,
        // multibot: bot MultiBota dostaje WYŁĄCZNIE serwery, które montujemy
        // niżej. Bez tego CLI dokłada globalną konfigurację MCP właściciela
        // maszyny — na telefonie bot widział prywatne konektory claude.ai
        // (Gmail, Supabase…), o które nikt go nie prosił i których nie
        // sprawdza żadna bramka uprawnień tego harnessu.
        "--strict-mcp-config",
      ];
      // Haiku has no adaptive-effort control in Claude Code.
      if (selectedModel !== "claude-haiku-4-5") args.push("--effort", requestedReasoning || "low");

      // integrations → MCP servers; this object is also the worker signature.
      const mcpServers: Record<string, unknown> = buildMcpServers(
        turn.integrations, undefined, canUseIntegration(threadId, "integrations"),
      );
      const allowed: string[] = Object.keys(mcpServers).map((name) => `mcp__${name}`);
      if (turn.integrations?.computer) {
        mcpServers.computer = { command: process.execPath, args: [PROXY_PATH], env: {
          ...NODE_ENV_FLAG, OGB_BOX_ID: turn.integrations.computer.boxId, OGB_BOX_TOKEN: turn.integrations.computer.token,
        } };
        allowed.push("mcp__computer");
      } else if (turn.integrations?.localComputer) {
        // multibot (A1): serwer komputera, ten sam stdio co u codexa. Claude
        // Code czeka na wolno wstające serwery i nie pomija ich po cichu —
        // wyścig z sekcji A1 (omitting pending optional MCP server) dotyczy
        // tylko codexa. Awarię serwera Claude raportuje w ToolSearch; tura nie
        // pada i bot wie, że komputera nie ma.
        mcpServers.computer = { ...turn.integrations.localComputer };
        allowed.push("mcp__computer");
      }
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents };
        allowed.push("mcp__agents");
      }
      const brokerNeeded = Boolean(policy || config.permissionMode !== "bypassPermissions");
      if (brokerNeeded) {
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
        mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG } };
        allowed.push("mcp__ogb");
      }
      const denied = [
        // multibot: własne narzędzie CLI do pytania człowieka działa tylko w
        // trybie interaktywnym. Tutaj model je wołał, nie dostawał nic i
        // oznajmiał „brak odpowiedzi" — pytanie nigdy nie docierało do czatu.
        // Odcinamy je, żeby model sięgnął po `mcp__agents__ask_user`, które
        // stawia w czacie prawdziwą kartę i czeka na człowieka.
        "AskUserQuestion",
        ...(policy ? [
          ...(policy.permissions.terminal === false ? ["Bash"] : []),
          ...(policy.permissions.file === false ? ["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"] : []),
          ...(policy.permissions.browser === false ? ["WebFetch", "WebSearch"] : []),
        ] : []),
      ];
      args.push("--disallowedTools", denied.join(","));
      if (Object.keys(mcpServers).length) {
        args.push("--mcp-config", JSON.stringify({ mcpServers }), "--allowedTools", allowed.join(","));
      }
      const signature = JSON.stringify({
        selectedModel, effort: selectedModel === "claude-haiku-4-5" ? null : requestedReasoning || "low",
        permissionMode, denied, cwd: turn.cwd ?? homedir(), system: turn.system ?? "", mcpServers,
      });

      let worker = workers.get(threadId);
      if (worker && worker.signature !== signature) {
        workers.delete(threadId);
        worker.broker?.close();
        killTree(worker.child);
        worker = undefined;
      }
      let spawnedWorker = false;
      if (!worker || worker.child.stdin?.destroyed) {
        // multibot (A1): Claude Code NIE ma wyścigu codexa — czeka na łączące się
      // serwery MCP (tool search / WaitForMcpServers), a awarię serwera zgłasza
      // Claude'owi zamiast cicho pominąć narzędzia. `MCP_TIMEOUT` to startup
      // timeout serwerów MCP (default 10 s; serwer komputera to Python i na
      // telefonie wstaje ~4 s — 30 s zostawia zapas na wolny dzień s10e).
      // Stdio serwery nie reconnectują się same, więc start musi się zmieścić
      // w tym oknie — stąd podbicie, a nie domyślne 10 s.
      const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error", MCP_TIMEOUT: "30000" };
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : newId();
        const launchArgs = [...args, typeof turn.resumeCursor === "string" ? "--resume" : "--session-id", sessionId, "--model", selectedModel];
        if (turn.system) launchArgs.push("--append-system-prompt", turn.system);
        const cli = resolveCliSpawn(config.cli, launchArgs);
        const child = spawn(cli.command, cli.args, {
          cwd: turn.cwd ?? homedir(), env, stdio: ["pipe", "pipe", "pipe"],
          windowsVerbatimArguments: cli.windowsVerbatimArguments, detached: true,
        });
        worker = { child, signature, sessionId, buffer: "", stderr: "" };
        workers.set(threadId, worker);
        spawnedWorker = true;
      }
      if (worker.idleTimer) clearTimeout(worker.idleTimer);
      const current: Turn = { turnId, settled: false, sawStreamDelta: false };
      worker.current = current;

      const settle = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (current.settled) return;
        current.settled = true;
        if (worker?.current === current) worker.current = undefined;
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost });
        if (worker && workers.get(threadId) === worker) {
          worker.idleTimer = setTimeout(() => {
            if (!worker?.current && workers.get(threadId) === worker) {
              workers.delete(threadId);
              worker.broker?.close();
              killTree(worker.child);
            }
          }, WORKER_IDLE_MS);
          worker.idleTimer.unref?.();
        }
      };
      const broker = worker.broker ?? (brokerNeeded ? createPermissionBroker({
        socketPath,
        onAsk: (ask) => {
          const remembered = approvalRule(DRIVER_KIND, ask.tool, ask.input, ask.suggestions);
          if (ask.kind === "permission" && !toolAllowed(threadId, ask.tool)) {
            queueMicrotask(() => worker?.broker?.answer(ask.id, "deny", `${ask.tool} blocked by bot permissions`));
            return;
          }
          if (ask.kind === "permission" && autoApproveAllowed(threadId, ask.tool)) {
            queueMicrotask(() => worker?.broker?.answer(ask.id, "allow"));
            return;
          }
          if (ask.kind === "permission" && approvalRuleAllowed(threadId, remembered)) {
            queueMicrotask(() => worker?.broker?.answer(ask.id, "always"));
            return;
          }
          const activeTurn = worker?.current;
          if (!activeTurn) return;
          emit({ ...base(threadId, activeTurn.turnId), type: "request.opened", requestId: ask.id,
            requestType: ask.kind, tool: ask.tool, summary: askSummary(ask),
            choices: Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
            ...(ask.kind === "permission" ? { approvalRule: remembered } : {}) });
        },
        onResolve: (resolved) => {
          const activeTurn = worker?.current;
          if (activeTurn) emit({ ...base(threadId, activeTurn.turnId), type: "request.resolved",
            requestId: resolved.id, behavior: resolved.behavior, source: resolved.source });
        },
      }) : undefined);
      if (broker) worker.broker = broker;
      current.broker = broker;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        if (!worker?.current) return;
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              worker!.sessionId = o.session_id ?? worker!.sessionId;
              const activeTurn = worker!.current;
              if (activeTurn) emit({ ...base(threadId, activeTurn.turnId), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              if (worker!.current) emit({ ...base(threadId, worker!.current.turnId), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            }
            break;
          case "stream_event": {
            // subagent narration is dropped — N parallel Tasks would
            // interleave their prose into one bubble (upstream-verified bug)
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              worker!.current!.sawStreamDelta = true;
              emit({ ...base(threadId, worker!.current!.turnId), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, worker!.current!.turnId), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            const text = firstText(msg.content);
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!worker!.current!.sawStreamDelta) {
                emit({ ...base(threadId, worker!.current!.turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              worker!.current!.sawStreamDelta = false;
              emit({ ...base(threadId, worker!.current!.turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({ ...base(threadId, worker!.current!.turnId), type: "item.started", itemType: "tool", itemId: b.id, title: b.name });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, worker!.current!.turnId),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, worker!.current!.turnId), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error });
              }
            }
            break;
          case "result":
            settle(o.is_error !== true, o.stop_reason ?? o.terminal_reason ?? null, o.total_cost_usd ?? null);
            break;
        }
      };
      worker.onLine = handleLine;
      worker.finish = settle;

      if (spawnedWorker) {
        worker.child.stdout!.on("data", (chunk) => {
          worker!.buffer += chunk;
          let nl;
          while ((nl = worker!.buffer.indexOf("\n")) !== -1) {
            const line = worker!.buffer.slice(0, nl);
            worker!.buffer = worker!.buffer.slice(nl + 1);
            if (line.trim()) worker!.onLine?.(line);
          }
        });
        worker.child.stderr!.on("data", (c) => {
          worker!.stderr += c;
          if (worker!.stderr.length > 8192) worker!.stderr = worker!.stderr.slice(-8192);
        });
        worker.child.once("error", (e) => {
          const activeTurn = worker!.current;
          const errorTurnId = activeTurn?.turnId ?? turnId;
          emit({ ...base(threadId, errorTurnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
          worker!.finish?.(false, "spawn_error");
        });
        worker.child.once("close", (code) => {
          const activeTurn = worker!.current;
          if (activeTurn && !activeTurn.settled) {
            emit({
              ...base(threadId, activeTurn.turnId),
              type: "runtime.error", message: `claude exited ${code} before result${worker!.stderr ? `: ${worker!.stderr.trim().slice(-300)}` : ""}`,
            });
            worker!.finish?.(false, "exit_before_result");
          }
          worker!.broker?.close();
          if (workers.get(threadId) === worker) workers.delete(threadId);
        });
      }

      const stop = () => {
        settle(true, "cancelled");
        killTree(worker!.child);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // Keep stdin open: Claude Code accepts multiple stream-json user frames.
      const nativeImages = (turn.attachments ?? []).filter((file) => /^image\/(?:png|jpeg|gif|webp)$/i.test(file.mime));
      const content = nativeImages.length
        ? [
            { type: "text", text: turn.text },
            ...nativeImages.map((file) => ({
              type: "image",
              source: { type: "base64", media_type: file.mime, data: readFileSync(file.path).toString("base64") },
            })),
          ]
        : turn.text;
      const promptMsg = { type: "user", message: { role: "user", content } };
      try {
        worker.child.stdin!.write(JSON.stringify(promptMsg) + "\n");
      } catch (error) {
        emit({ ...base(threadId, turnId), type: "runtime.error", message: `claude input failed: ${error instanceof Error ? error.message : String(error)}` });
        settle(false, "stdin_error");
        killTree(worker.child);
      }
      appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: promptMsg });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        const cli = resolveCliSpawn(config.cli, ["--version"]); // multibot
        execFile(
          cli.command,
          cli.args,
          {
            timeout: 8000,
            env: { ...process.env, PATH: augmentedPath() },
            windowsVerbatimArguments: cli.windowsVerbatimArguments,
          },
          (err, stdout) => resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const termuxRoot = process.env.PREFIX
        ? join(process.env.PREFIX, "var", "lib", "proot-distro", "installed-rootfs", "debian", "root")
        : null;
      const authenticated = [
        join(homedir(), ".claude", ".credentials.json"),
        ...(termuxRoot ? [join(termuxRoot, ".claude", ".credentials.json")] : []),
      ].some(existsSync);
      return { state: "available", version, authenticated };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const broker = active.get(threadId)?.broker;
          if (!broker) throw new Error("no active turn with a permission broker on this thread");
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message)) {
            throw new Error("no such pending request (it may have timed out)");
          }
        },
        hasSession: (threadId) => workers.has(threadId),
        stopAll: async () => {
          for (const worker of workers.values()) {
            worker.broker?.close();
            killTree(worker.child);
          }
          workers.clear();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          // multibot
          const cli = resolveCliSpawn(config.cli, ["-p", prompt, "--model", "haiku", "--output-format", "text"]);
          execFile(
            cli.command,
            cli.args,
            {
              timeout: 60_000,
              env: { ...process.env, PATH: augmentedPath() },
              windowsVerbatimArguments: cli.windowsVerbatimArguments,
            },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
      dispose: async () => {
        for (const worker of workers.values()) {
          worker.broker?.close();
          killTree(worker.child);
        }
        workers.clear();
        listeners.clear();
      },
    };
  },
};

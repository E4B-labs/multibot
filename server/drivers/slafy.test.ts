// multibot: kontraktowe testy drivera slafy na fake'owym silniku HTTP
// (server/testing/fake-engine.ts). Pozostałe drivery testują się na fake CLI —
// slafy jest driverem HTTP, więc fake'iem jest serwer.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { ensureEngine } from "../engine/supervisor.ts";
import { removeConnector, saveConnector } from "../mcp-connectors.ts";
import { startFakeEngine, type FakeEngine, type FakeEngineMode } from "../testing/fake-engine.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { SlafyDriver } from "./slafy.ts";

describe("SlafyDriver.decodeConfig", () => {
  it("defaults the engine bot-id prefix", () => {
    expect(SlafyDriver.decodeConfig({})).toEqual({ botPrefix: "mb-" });
    expect(SlafyDriver.decodeConfig(undefined)).toEqual({ botPrefix: "mb-" });
    expect(SlafyDriver.decodeConfig({ botPrefix: "x-" }).botPrefix).toBe("x-");
  });

  it("decodes a configured model and base URL", () => {
    expect(
      SlafyDriver.decodeConfig({ model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" } }),
    ).toEqual({
      botPrefix: "mb-",
      model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" },
    });
  });
});

describe("SlafyDriver turns (fake engine)", () => {
  let engine: FakeEngine;
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (mode: FakeEngineMode = "happy") => {
    engine = await startFakeEngine(mode);
    // ENGINE_URL = silnik zewnętrzny: supervisor tylko sonduje /health, zero spawnu.
    process.env.ENGINE_URL = engine.url;
    instance = await SlafyDriver.create({
      instanceId: "slafy-test",
      displayName: "Slafy Test",
      environment: {},
      enabled: true,
      config: SlafyDriver.defaultConfig(),
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    delete process.env.ENGINE_URL;
  });

  afterEach(async () => {
    delete process.env.ENGINE_URL;
    recorder?.stop();
    await instance?.dispose();
    await engine?.close();
  });

  it("normalizes a full streamed turn into canonical events", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-happy", text: "czesc" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "item.started", // working → pierwsze wystąpienie toolCallId
      "content.delta",
      "content.delta",
      "content.delta",
      "thread.token-usage.updated",
      "item.completed", // assistant_text z eventu `done`
      "turn.completed",
    ]);

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.map((e: any) => e.delta).join("")).toBe("Hello, world");
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 11,
      output: 7,
    });
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "Hello, world",
    });
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("creates the engine bot once per thread and sends only the new turn", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-one",
      text: "pierwsza",
      // D4: transkrypt MUSI zostać zignorowany — silnik jest stanowy.
      transcript: [
        { role: "user", text: "stara tura" },
        { role: "assistant", text: "stara odpowiedz" },
      ],
    });
    await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "t-one", text: "druga" });
    await recorder.until((e) => e.type === "turn.completed" && recorder.events.filter((x) => x.type === "turn.completed").length === 2);

    expect(engine.createdBots).toEqual(["mb-t-one"]); // drugi raz już nie zakłada
    expect(engine.chats.map((c) => c.message)).toEqual(["pierwsza", "druga"]);
    expect(JSON.stringify(engine.chats)).not.toContain("stara tura");
  });

  it("pushes per-instance provider settings before a custom-model turn", async () => {
    engine = await startFakeEngine();
    process.env.ENGINE_URL = engine.url;
    instance = await SlafyDriver.create({
      instanceId: "local-qwen",
      displayName: "Local Qwen",
      environment: { OPENAI_API_KEY: "test-key" },
      enabled: true,
      config: SlafyDriver.decodeConfig({
        model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" },
      }),
    });
    recorder = recordEvents(instance.adapter);

    expect(instance.models).toEqual({ default: "qwen2.5", options: [{ id: "qwen2.5", label: "qwen2.5" }] });
    await instance.adapter.sendTurn({ threadId: "t-custom", text: "czesc", model: "qwen2.5" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(engine.chats.at(-1)).toMatchObject({ message: "czesc", model: "qwen2.5" });
    expect(engine.provider).toEqual({
      provider: "custom",
      model: "qwen2.5",
      base_url: "http://127.0.0.1:11434/v1",
      has_key: true,
    });
  });

  it("turns a mid-turn engine kill into a clean runtime.error", async () => {
    await create("kill");
    await instance.adapter.sendTurn({ threadId: "t-kill", text: "czesc" });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error");
    expect(error).toBeDefined();
    expect((error as any).message).toMatch(/stream ended|fetch failed|terminated|socket/i);
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    // deltas sprzed zerwania nie giną — user widzi, co zdążyło przyjść
    expect(recorder.events.filter((e) => e.type === "content.delta")).toHaveLength(2);
    expect(instance.adapter.hasSession("t-kill")).toBe(false);
  });

  it("surfaces an engine-reported error event as runtime.error", async () => {
    await create("error");
    await instance.adapter.sendTurn({ threadId: "t-err", text: "czesc" });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "engine blew up",
    });
    expect(completed).toMatchObject({ ok: false });
  });

  // ── F4: zgody ────────────────────────────────────────────────────────────
  // Test kluczowy fazy: tura STOI na `request.opened`, a dopiero odpowiedź
  // przez `respondToRequest` doprowadza strumień do `turn.completed`.
  it("opens a permission request mid-turn and finishes the turn after allow", async () => {
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "t-ask", text: "usun plik" });
    const opened: any = await recorder.until((e) => e.type === "request.opened");

    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "terminal",
      choices: ["Allow", "Deny", "Always allow"],
    });
    expect(opened.summary).toContain("rm -rf /tmp/x");
    expect(opened.requestId).toBe(engine.approvalRequestId);
    // Tura wisi: nic po prośbie nie przyszło i silnik nie zna jeszcze decyzji.
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(engine.approvals).toEqual([]);

    await instance.adapter.respondToRequest("t-ask", opened.requestId, { behavior: "allow" });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(engine.approvals).toEqual([
      { botId: "mb-t-ask", requestId: opened.requestId, decision: "allow" },
    ]);
    expect(recorder.events.find((e) => e.type === "request.resolved")).toMatchObject({
      requestId: opened.requestId,
      behavior: "allow",
      source: "user",
    });
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "Zrobione.",
    });
    expect(completed).toMatchObject({ ok: true });
  });

  it("denies on Deny and on anything it cannot map, and passes Always allow through", async () => {
    for (const [decision, behavior, message] of [
      ["deny", "deny", undefined],
      ["always", "answer", "Always allow"],
      ["deny", "answer", "Może później"], // nieznana opcja = odmowa, nigdy zgoda
    ] as const) {
      await create("approval");
      const threadId = `t-${decision}-${behavior}`;
      await instance.adapter.sendTurn({ threadId, text: "usun plik" });
      const opened: any = await recorder.until((e) => e.type === "request.opened");

      await instance.adapter.respondToRequest(threadId, opened.requestId, { behavior, message });
      const completed = await recorder.until((e) => e.type === "turn.completed");

      expect(engine.approvals.at(-1)).toMatchObject({ decision });
      expect(completed).toMatchObject({ ok: true }); // odmowa domyka turę, nie wywraca jej
      const text = recorder.events.find((e) => e.type === "item.completed") as any;
      expect(text.text).toBe(decision === "deny" ? "Nie mam zgody." : "Zrobione.");

      recorder.stop();
      await instance.dispose();
      await engine.close();
    }
  });

  it("rejects an answer to a request the engine no longer knows", async () => {
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "t-stale", text: "usun plik" });
    await recorder.until((e) => e.type === "request.opened");

    await expect(
      instance.adapter.respondToRequest("t-stale", "req-nieznane", { behavior: "allow" }),
    ).rejects.toThrow(/404/);
  });

  // F7: silnik montuje MCP sam (per bot, z `plugins.json`), więc driver niczego
  // nie montuje — dosyła mu rejestr konektorów harnessu.
  it("pushes the user's MCP connectors into the engine and prunes only its own", async () => {
    await create();
    engine.plugins["mb-stare"] = { url: "https://stare.dev/mcp" }; // nasz, już usunięty z configu
    engine.plugins.context7 = { url: "https://mcp.context7.com/mcp" }; // z marketplace'u silnika
    saveConnector("echo", { name: "Echo", transport: { type: "stdio", command: "node", args: ["echo.mjs"] } });
    saveConnector("firma", {
      transport: { type: "http", url: "https://mcp.firma.dev/mcp", headers: { authorization: "Bearer x" } },
    });
    try {
      await instance.adapter.sendTurn({ threadId: "t-mcp", text: "czesc" });
      await recorder.until((e) => e.type === "turn.completed");

      expect(engine.plugins["mb-echo"]).toEqual({ command: "node", args: ["echo.mjs"], env: {} });
      expect(engine.plugins["mb-firma"]).toEqual({
        url: "https://mcp.firma.dev/mcp",
        headers: { authorization: "Bearer x" },
      });
      expect(engine.plugins["mb-stare"]).toBeUndefined();
      expect(engine.plugins.context7).toBeDefined(); // cudzych wpisów nie ruszamy
      expect(engine.pluginCalls).toEqual(["GET", "DELETE mb-stare", "POST mb-echo", "POST mb-firma"]);

      // Zestaw bez zmian = zero HTTP przy kolejnej turze.
      await instance.adapter.sendTurn({ threadId: "t-mcp", text: "druga" });
      await recorder.until(() => recorder.events.filter((e) => e.type === "turn.completed").length === 2);
      expect(engine.pluginCalls).toHaveLength(4);
    } finally {
      removeConnector("echo");
      removeConnector("firma");
    }
  });

  // F9: multi-agent. Warstwa komunikacji jest harnessu (`integrations.agents` =
  // spawn `drivers/agents-proxy.ts`), silnik dostaje ją jak każdy inny MCP —
  // tyle że PER BOT, bo w env siedzi id konkretnego bota.
  it("declares agentsMcp so the harness mounts the peer-comms tools", async () => {
    await create();
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
  });

  it("mounts the harness agents proxy into the engine bot's own profile", async () => {
    await create();
    const agents = {
      command: "/usr/bin/node",
      args: ["/app/server/drivers/agents-proxy.ts"],
      env: { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_BOT_ID: "bot-1", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" },
    };
    await instance.adapter.sendTurn({ threadId: "t-agents", text: "czesc", integrations: { agents } });
    await recorder.until((e) => e.type === "turn.completed");

    // spec 1:1 ze spawnu harnessu — stdio Hermesa ma dokładnie ten kształt
    expect(engine.botMcp["mb-t-agents"]?.["mb-agents"]).toEqual(agents);
    expect(engine.botMcpCalls).toEqual(["PUT mb-t-agents/mb-agents"]);
    // ...i NIE w globalnym rejestrze pluginów: tamten idzie na wszystkie profile,
    // a `OMB_BOT_ID` jest inny dla każdego bota.
    expect(engine.plugins["mb-agents"]).toBeUndefined();

    // ten sam spawn = zero HTTP przy kolejnej turze
    await instance.adapter.sendTurn({ threadId: "t-agents", text: "druga", integrations: { agents } });
    await recorder.until(() => recorder.events.filter((e) => e.type === "turn.completed").length === 2);
    expect(engine.botMcpCalls).toHaveLength(1);
  });

  it("runs the turn even when the agents mount fails, and retries next turn", async () => {
    await create();
    // spawn bez transportu → 422 z trasy per-bot; tura ma to przeżyć
    const agents = { command: "", args: [], env: {} };
    await instance.adapter.sendTurn({ threadId: "t-agents-fail", text: "czesc", integrations: { agents } });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(engine.botMcp["mb-t-agents-fail"]).toBeUndefined();
  });

  it("builds the model catalog per instance without touching describe()", async () => {
    await create();
    expect(instance.models).toEqual({
      default: "hermes-agent",
      options: [{ id: "hermes-agent", label: "Custom model" }],
    });
    // per instancja = nie ta sama referencja co katalog drivera (D5)
    expect(instance.models).not.toBe(SlafyDriver.models);
    expect(instance.models).toEqual(SlafyDriver.models);
  });

  it("reports available when the engine answers and unavailable when it does not", async () => {
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available" });

    await engine.close();
    const dead = await instance.snapshot();
    expect(dead.state).toBe("unavailable");
    expect(dead.reason).toContain(engine.url);
  });
});

// D4: tury, które zaszły przy zamkniętej apce (rutyny, interbot), mają trafić
// do transkryptu przy podłączeniu instancji — i ANI RAZU więcej.
describe("SlafyDriver attach-sync (D4)", () => {
  let engine: FakeEngine;
  let instance: ProviderInstance | null = null;
  let recorder: EventRecorder;

  // attach-sync pisze kursor przez `appendNative` — bez katalogów cicho by go zgubił
  beforeAll(() => ensureDirs());

  const attach = async () => {
    if (instance) await instance.dispose();
    instance = await SlafyDriver.create({
      instanceId: "slafy-sync",
      displayName: "Slafy Sync",
      environment: {},
      enabled: true,
      config: SlafyDriver.defaultConfig(),
    });
    recorder = recordEvents(instance.adapter);
    return instance;
  };

  const seedBot = (botId: string, history: Array<{ role: string; content: string }>) => {
    engine.createdBots.push(botId);
    engine.history[botId] = [...history];
  };

  beforeEach(async () => {
    engine = await startFakeEngine();
    process.env.ENGINE_URL = engine.url;
    instance = null;
  });

  afterEach(async () => {
    delete process.env.ENGINE_URL;
    recorder?.stop();
    await instance?.dispose();
    await engine?.close();
  });

  it("replays engine turns the harness never saw", async () => {
    seedBot("mb-t-attach", [
      { role: "user", content: "[rutyna 07:00]" },
      { role: "assistant", content: "raport gotowy" },
    ]);
    await attach();

    const replayed = await recorder.until((e) => e.type === "item.completed");
    expect(replayed).toMatchObject({ itemType: "assistant_text", text: "raport gotowy", threadId: "t-attach" });
    // znacznik pochodzenia zostaje w evencie (i w NDJSON) — sync ≠ tura na żywo
    expect((replayed as any).raw?.source).toBe("slafy.sync");
    // domknięcie turą, żeby sidebar zapalił `unread`
    await recorder.until((e) => e.type === "turn.completed");
    // prompt rutyny zostaje po stronie silnika: strumień kanoniczny nie ma
    // eventu tworzącego wiadomość USERA
    expect(recorder.events.filter((e) => e.type === "item.completed")).toHaveLength(1);
  });

  it("resumes from its own cursor instead of replaying the whole history", async () => {
    seedBot("mb-t-cursor", [
      { role: "user", content: "[rutyna]" },
      { role: "assistant", content: "pierwsza" },
    ]);
    await attach();
    await recorder.until((e) => e.type === "turn.completed");
    recorder.stop();

    // silnik dorobił jeszcze jedną turę, zanim apka wstała drugi raz
    engine.history["mb-t-cursor"].push({ role: "assistant", content: "druga" });
    await attach();

    const next = await recorder.until((e) => e.type === "item.completed");
    expect(next).toMatchObject({ text: "druga" });
    // gdyby kursor nie przeżył, "pierwsza" byłaby TU, przed "drugą"
    expect(recorder.events.filter((e) => e.type === "item.completed")).toHaveLength(1);
  });

  it("does not replay a turn the harness itself sent", async () => {
    const live = await attach();
    await live.adapter.sendTurn({ threadId: "t-live", text: "czesc" });
    await recorder.until((e) => e.type === "turn.completed");
    recorder.stop();
    // fake silnik dopisał turę do historii (user + assistant), jak prawdziwy
    expect(engine.history["mb-t-live"]).toHaveLength(2);

    engine.history["mb-t-live"].push({ role: "assistant", content: "po godzinach" });
    await attach();

    await recorder.until((e) => e.type === "item.completed" && (e as any).text === "po godzinach");
    expect(recorder.events.filter((e) => e.type === "item.completed")).toHaveLength(1);
  });
});

// Wyłącznik silnika: żywy silnik pod ENGINE_URL i tak ma być odrzucony, bo
// `MULTIBOT_ENGINE=off` znaczy "nie tykamy silnika w ogóle" (pamięć telefonu).
describe("ensureEngine with MULTIBOT_ENGINE=off", () => {
  let engine: FakeEngine;

  afterEach(async () => {
    delete process.env.MULTIBOT_ENGINE;
    delete process.env.ENGINE_URL;
    await engine?.close();
  });

  it("rejects without spawning or probing, even with a live engine", async () => {
    engine = await startFakeEngine();
    process.env.ENGINE_URL = engine.url;
    process.env.MULTIBOT_ENGINE = "off";
    await expect(ensureEngine()).rejects.toThrow(/silnik wy/);
  });
});

describe("ensureEngine with ENGINE_URL", () => {
  let engine: FakeEngine;

  afterEach(async () => {
    delete process.env.ENGINE_URL;
    await engine?.close();
  });

  it("uses the external engine and never spawns", async () => {
    engine = await startFakeEngine();
    process.env.ENGINE_URL = engine.url;
    expect(await ensureEngine()).toBe(engine.url);
  });

  it("rejects instead of spawning when ENGINE_URL is dead", async () => {
    engine = await startFakeEngine();
    const url = engine.url;
    await engine.close();
    process.env.ENGINE_URL = url;
    await expect(ensureEngine()).rejects.toThrow(/no engine at ENGINE_URL/);
  });
});

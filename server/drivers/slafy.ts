// multibot: driver silnika slafy (Python FastAPI, engine/). Jak grok.ts jest to
// driver HTTP, nie CLI — ale różnica jest głębsza niż transport:
//
//   grok.ts jest BEZSTANOWY i co turę odtwarza cały transkrypt z harnessu.
//   Silnik slafy jest STANOWY — każdy bot ma własny profil Hermesa i własną
//   historię w `hermes_state.db`. Dlatego `SendTurnInput.transcript` tu
//   IGNORUJEMY i wysyłamy WYŁĄCZNIE nową turę. Replay podwoiłby historię
//   i policzył ją drugi raz w tokenach (decyzja D4).
//
// Transkrypt harnessu (NDJSON) zostaje jedynym źródłem renderu; silnik trzyma
// swój własny, równoległy stan rozmowy i to jest w porządku — nikt ich nie scala.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { approvalRule } from "../approval-rules.ts";
import { NATIVE_DIR, loadConfig } from "../config.ts";
import { EngineUnavailableError, ensureEngine, engineBaseUrl } from "../engine/supervisor.ts";
import { connectors as customConnectors } from "../mcp-connectors.ts";
import { engineSpec } from "../mcp-servers.ts";
import { approvalRuleAllowed } from "../turn-policy.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "slafy";
/** Prefiks naszych wpisów w `/api/plugins` silnika — patrz `syncConnectors`. */
export const ENGINE_PLUGIN_PREFIX = "mb-";
/** Nazwa wpisu `mcp_servers` z warstwą komunikacji harnessu — patrz `syncAgents`.
 * Kolizji nie ma: `agents` jest zarezerwowane w `mcp-connectors.ts`, a ten wpis
 * żyje w configu PROFILU, nie w `plugins.json`, więc prune z F7 go nie widzi. */
export const ENGINE_AGENTS_MCP = "mb-agents";

/** Domyślny prefiks id bota w silniku. Odwzorowanie `mb-<threadId>` jest
 * wyliczalne w obie strony, więc nikt (ani driver, ani harness przy uwadze
 * D7) nie musi trzymać mapy wątek↔bot silnika. */
export const ENGINE_BOT_PREFIX = "mb-";
/** Odstęp między `create()` a attach-syncem — patrz kickoff na końcu `create`. */
const ATTACH_SYNC_DELAY_MS = 500;
export const engineBotIdFor = (threadId: string, prefix = ENGINE_BOT_PREFIX) => `${prefix}${threadId}`;
export const threadIdOfEngineBot = (botId: string, prefix = ENGINE_BOT_PREFIX) =>
  botId.startsWith(prefix) ? botId.slice(prefix.length) : null;

// multibot (G1): one configured model per named instance. The instance name is
// the provider label; model id stays exact so local OpenAI-compatible servers
// can expose arbitrary ids without a catalog endpoint.
function modelCatalog(model = "hermes-agent"): ModelCatalog {
  return { default: model, options: [{ id: model, label: model === "hermes-agent" ? "Custom model" : model }] };
}

export interface SlafyConfig {
  /** Prefiks id bota w silniku; id = `<prefix><threadId>` (regex silnika: a-z0-9_-). */
  botPrefix: string;
  /** multibot (G1): OpenAI-compatible endpoint selected by this instance. */
  model?: { default: string; baseUrl?: string };
}

function decodeConfig(raw: unknown): SlafyConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const model = o.model && typeof o.model === "object" ? (o.model as Record<string, unknown>) : null;
  return {
    botPrefix: typeof o.botPrefix === "string" ? o.botPrefix : ENGINE_BOT_PREFIX,
    ...(model && typeof model.default === "string" && model.default.trim()
      ? {
          model: {
            default: model.default.trim(),
            ...(typeof model.baseUrl === "string" && model.baseUrl.trim() ? { baseUrl: model.baseUrl.trim() } : {}),
          },
        }
      : {}),
  };
}

/** Jedna ramka SSE: `event:` (opcjonalnie) + `data:` z JSON-em. */
async function* sseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let name = "";
        let data = "";
        for (const raw of block.split("\n")) {
          const line = raw.replace(/\r$/, "");
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!name || !data) continue;
        try {
          yield { name, payload: JSON.parse(data) as any };
        } catch {
          /* ramka nie-JSON — nic, czego umiemy użyć */
        }
      }
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const SlafyDriver: ProviderDriver<SlafyConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Custom model", supportsMultipleInstances: true },
  models: modelCatalog(),
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<SlafyConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    let disposed = false;
    // Bot silnika per WĄTEK, nie per instancja: jedna instancja `slafy` obsługuje
    // całą flotę botów harnessu, a każdy z nich musi mieć własny, stanowy profil.
    // Id jest wyliczane z threadId, więc przeżywa restart bez zapisywania czegokolwiek.
    const ensuredBots = new Set<string>();
    const engineBotId = (threadId: string) => engineBotIdFor(threadId, config.botPrefix);

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    /** Bot silnika zakładany leniwie, przy pierwszym użyciu wątku. */
    const ensureBot = async (baseUrl: string, threadId: string) => {
      const botId = engineBotId(threadId);
      if (!ensuredBots.has(botId)) {
        const res = await fetch(`${baseUrl}/api/bots`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: botId, name: botId }),
          signal: AbortSignal.timeout(30_000),
        });
        // 409 = bot już jest (restart harnessu, ten sam wątek) — to sukces, nie błąd.
        if (!res.ok && res.status !== 409) {
          throw new Error(`engine POST /api/bots → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        ensuredBots.add(botId);
      }
      // multibot (G1): push every turn. Two custom instances can target the
      // same engine bot, so either one may have changed its provider last.
      if (config.model) {
        const configured = await fetch(`${baseUrl}/api/bots/${encodeURIComponent(botId)}/provider`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "custom",
            api_key: input.environment.OPENAI_API_KEY ?? "",
            base_url: config.model.baseUrl ?? null,
            model: config.model.default,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!configured.ok) throw new Error(`engine provider configuration -> HTTP ${configured.status}`);
      }
      return botId;
    };

    // ── F7: własne konektory MCP użytkownika → silnik ───────────────────────
    // Driver NICZEGO nie montuje sam: silnik ma własną warstwę MCP per bot
    // (`plugins.json` → `mcp_servers` w profilu każdego bota), więc dosyłamy mu
    // rejestr konektorów harnessu przez `/api/plugins`. Prefiks `mb-` oddziela
    // nasze wpisy od pluginów zainstalowanych w marketplace silnika — kasujemy
    // wyłącznie własne, gdy znikną z configu harnessu.
    let syncedConnectors: string | null = null;
    const syncConnectors = async (baseUrl: string) => {
      const wanted = customConnectors();
      // multibot: Composio do silnika — Hermes musi widzieć te same narzędzia
      // co Claude/Codex. Bez tego boty slafy (silnik) nie miały Gmaila itp.
      const composioKey = loadConfig().composio?.key;
      if (composioKey) {
        wanted.push({
          id: "composio",
          name: "Composio",
          transport: { type: "http", url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": composioKey } },
        });
      }
      const signature = JSON.stringify(wanted);
      if (signature === syncedConnectors) return; // zestaw bez zmian — zero HTTP
      const names = new Set(wanted.map((c) => ENGINE_PLUGIN_PREFIX + c.id));
      const res = await fetch(`${baseUrl}/api/plugins`, { signal: AbortSignal.timeout(10_000) });
      const installed = res.ok ? ((await res.json()) as Array<{ name?: string }>) : [];
      for (const plugin of installed) {
        const name = String(plugin?.name ?? "");
        if (!name.startsWith(ENGINE_PLUGIN_PREFIX) || names.has(name)) continue;
        await fetch(`${baseUrl}/api/plugins/${encodeURIComponent(name)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(10_000),
        });
      }
      for (const connector of wanted) {
        // Instalacja jest idempotentna i MERGUJE spec, więc to samo wywołanie
        // roznosi także zmieniony token istniejącego konektora.
        const install = await fetch(`${baseUrl}/api/plugins/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: ENGINE_PLUGIN_PREFIX + connector.id, spec: engineSpec(connector) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!install.ok) {
          throw new Error(
            `engine POST /api/plugins/install (${connector.id}) → HTTP ${install.status}: ${(await install.text().catch(() => "")).slice(0, 200)}`,
          );
        }
      }
      syncedConnectors = signature;
    };

    // ── F9: warstwa komunikacji harnessu (agents MCP) → profil bota ─────────
    // Multi-agent zostaje ICH: `integrations.agents` to gotowy kontrakt spawnu
    // `drivers/agents-proxy.ts` (list_bots / ask_bot), który routuje z powrotem
    // do harnessu — więc to harness dalej jest jedynym właścicielem tur, zgód i
    // limitu rekurencji, a bot silnika dosięga KAŻDEGO bota floty (claude, codex,
    // slafy), nie tylko swoich. Silnik dokłada do tego swoją delegację po opisie
    // (`interbot.route_by_description`) i grupy — transport ma jeden.
    //
    // Zero renderowania: kształt `{command, args, env}` JEST kształtem wpisu
    // stdio w `mcp_servers` Hermesa (dokładnie to, co `engineSpec` oddaje dla
    // konektora stdio), więc przekazujemy go 1:1.
    //
    // PER BOT, nie przez `/api/plugins/install`: tamta trasa rozprowadza jeden
    // zestaw na wszystkie profile, a `OMB_BOT_ID` w env jest inny dla każdego
    // bota — wspólny wpis dałby całej flocie tożsamość jednego z nich.
    const syncedAgents = new Map<string, string>();
    const syncAgents = async (
      baseUrl: string,
      botId: string,
      agents: NonNullable<SendTurnInput["integrations"]>["agents"],
    ) => {
      if (!agents) return; // tura bez peerów albo driver bez uprawnienia — nie ma co montować
      const signature = JSON.stringify(agents);
      if (syncedAgents.get(botId) === signature) return; // ten sam spawn — zero HTTP
      // `OMB_COMMS_TOKEN` rotuje przy każdym starcie harnessu, a ta mapa żyje tyle
      // co instancja drivera — więc pierwsza tura po restarcie i tak dosyła nowy.
      const res = await fetch(
        `${baseUrl}/api/bots/${encodeURIComponent(botId)}/mcp/${encodeURIComponent(ENGINE_AGENTS_MCP)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spec: { command: agents.command, args: agents.args, env: agents.env } }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        throw new Error(
          `engine PUT /api/bots/${botId}/mcp/${ENGINE_AGENTS_MCP} → HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        );
      }
      syncedAgents.set(botId, signature);
    };

    // ── D4: attach-sync ────────────────────────────────────────────────────
    // Rutyny (cron/webhook) i rozmowy międzybotowe chodzą w silniku także przy
    // zamkniętej apce. Przy podłączeniu instancji dosyłamy to, czego transkrypt
    // harnessu nie widział — zwykłymi eventami kanonicznymi, więc NDJSON i store
    // zapisują się dokładnie tą samą drogą co tura na żywo.
    //
    // Kursor = LICZBA wiadomości silnika, które harness już zna, wyliczona z
    // natywnego logu drivera (`native/<threadId>.ndjson`) — jedynego stanu, jaki
    // driver i tak persystuje. `resumeCursors` odpada: driver dostaje je dopiero
    // w `sendTurn`, a sync ma zajść PRZED pierwszą turą.
    const seenCount = (threadId: string): number => {
      let log: string;
      try {
        log = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
      } catch {
        return 0; // wątek, którego ten driver jeszcze nie dotykał
      }
      let seen = 0;
      for (const line of log.split("\n")) {
        if (!line.trim()) continue;
        let entry: { dir?: string; source?: string; msg?: any };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        // znacznik ostatniego syncu niesie wartość BEZWZGLĘDNĄ i kasuje zliczanie
        if (entry.source === "slafy.sync") seen = Number(entry.msg?.seen) || 0;
        else if (entry.source === "slafy.chat" && entry.dir === "out") seen++;
        else if (entry.source === "slafy.chat" && entry.dir === "in" && String(entry.msg?.reply ?? "").trim()) seen++;
      }
      return seen;
    };

    const syncThread = async (baseUrl: string, botId: string, threadId: string) => {
      // Instancja po `dispose()` NIE dosyła: emit poszedłby do pustego zbioru
      // słuchaczy, a kursor i tak by się przesunął — wiadomości zniknęłyby na
      // zawsze. Dotyczy każdego przeładowania floty (`reloadProviders`).
      if (disposed) return;
      // tura w locie sama dopisze swój wynik — sync wszedłby jej w słowo
      if (active.has(threadId)) return;
      const res = await fetch(`${baseUrl}/api/bots/${encodeURIComponent(botId)}/messages`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return;
      const history = (await res.json()) as Array<{ role?: string; content?: string }>;
      const seen = seenCount(threadId);
      // ponytail: kursor pozycyjny, bo wiadomości silnika nie mają id (gateway
      // oddaje role/content/ts). Ceiling: historia jest ucinana do ostatnich 500,
      // więc po przekroczeniu okna pozycje się przesuwają — wtedy odpuszczamy.
      // Upgrade: id albo `since` po stronie silnika, gdy to okno zacznie boleć.
      if (!Array.isArray(history) || seen > history.length) return;
      const turnId = newId();
      let emitted = 0;
      for (const msg of history.slice(seen)) {
        // Tylko asystent: kanoniczny strumień nie ma eventu tworzącego wiadomość
        // USERA (te dopisuje harness przy wysyłce), więc prompt rutyny zostaje po
        // stronie silnika. Kursor liczy obie role, bo liczy pozycje w historii.
        if (msg?.role !== "assistant" || !String(msg.content ?? "").trim()) continue;
        emit({
          ...base(threadId, turnId),
          type: "item.completed",
          itemType: "assistant_text",
          text: msg.content!,
          raw: { source: "slafy.sync", payload: msg },
        });
        emitted++;
      }
      if (history.length > seen) {
        appendNative(threadId, { dir: "in", source: "slafy.sync", msg: { seen: history.length } });
      }
      // domknięcie jak przy zwykłej turze — w sidebarze zapala `unread`
      if (emitted) emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, cost: null });
    };

    const attachSync = async () => {
      // Silnika NIE podnosimy (`engineBaseUrl`, nie `ensureEngine`): stoi = rutyny
      // mogły coś zrobić, nie stoi = nie miały kiedy. Leniwy kontrakt z F2 zostaje.
      const baseUrl = engineBaseUrl();
      const res = await fetch(`${baseUrl}/api/bots`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const bots = (await res.json()) as Array<{ id?: string }>;
      for (const bot of Array.isArray(bots) ? bots : []) {
        const threadId = bot?.id ? threadIdOfEngineBot(bot.id, config.botPrefix) : null;
        if (threadId) await syncThread(baseUrl, bot.id!, threadId);
      }
    };

    // ── F4: zgody ──────────────────────────────────────────────────────────
    // Silnik wystawia prośbę eventem SSE `approval` i STOI, aż ktoś odpowie na
    // `POST /api/bots/<bot>/approvals/<request_id>`. Tu tłumaczymy to na parę
    // kanoniczną `request.opened` / `request.resolved` — czyli na dokładnie te
    // eventy, z których index.ts składa kartę Allow/Deny w czacie.
    //
    // Mapowanie decyzji: kontrakt (`contracts.ts`) zna tylko allow/deny/answer,
    // a silnik dodatkowo „always". Front wysyła etykietę klikniętej opcji jako
    // `answer` + `message`, więc „Always allow" rozpoznajemy po treści. Wszystko,
    // czego nie umiemy zmapować, leci jako ODMOWA — zgoda przez pomyłkę byłaby
    // gorsza niż niepotrzebne pytanie.
    const requestTurn = new Map<string, string>(); // requestId → turnId, na którym padła prośba
    const decisionOf = (behavior: string, message?: string) => {
      if (behavior === "allow") return "allow";
      if (behavior === "always") return "always";
      if (behavior === "answer" && /always/i.test(message ?? "")) return "always";
      return "deny";
    };

    const respondToRequest = async (
      threadId: string,
      requestId: string,
      decision: { behavior: "allow" | "always" | "deny" | "answer"; message?: string },
    ) => {
      // `engineBaseUrl`, nie `ensureEngine`: odpowiadamy na prośbę ŻYWEJ tury,
      // więc silnik z definicji stoi — podnoszenie go tutaj tylko maskowałoby
      // wyścig (prośba z procesu, którego już nie ma).
      const botId = engineBotId(threadId);
      const value = decisionOf(decision.behavior, decision.message);
      const res = await fetch(
        `${engineBaseUrl()}/api/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(requestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: value }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        // 404 = prośba wygasła (timeout silnika) albo odpowiedział ktoś inny.
        throw new Error(`engine approval → HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
      const turnId = requestTurn.get(requestId) ?? active.get(threadId)?.turnId ?? newId();
      requestTurn.delete(requestId);
      emit({
        ...base(threadId, turnId),
        type: "request.resolved",
        requestId,
        behavior: value,
        source: "user",
      });
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const baseUrl = await ensureEngine();
      const botId = await ensureBot(baseUrl, threadId);
      // F7: konektory dosyłamy PRZED turą, ale ich awaria jej nie wywraca —
      // rozmowa bez jednego serwera MCP jest lepsza niż brak rozmowy. Podpis
      // zostaje niezapisany, więc następna tura spróbuje jeszcze raz.
      await syncConnectors(baseUrl).catch((e) =>
        appendNative(threadId, { dir: "out", source: "slafy.mcp", msg: { error: String(e) } }),
      );
      // F9: to samo co wyżej i z tego samego powodu — PO `ensureBot`, bo silnik
      // pisze do configu PROFILU (bez profilu merge jest cichym no-opem), i bez
      // wywracania tury, gdy nie wyjdzie: rozmowa bez ask_bot jest lepsza niż brak.
      await syncAgents(baseUrl, botId, turn.integrations?.agents).catch((e) =>
        appendNative(threadId, { dir: "out", source: "slafy.agents", msg: { error: String(e) } }),
      );

      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: botId, model: turn.model ?? null });

      void (async () => {
        // D4: TYLKO nowa tura. `turn.transcript` celowo nieużyte — silnik ma własną historię.
        let done = false;
        let failure: string | null = null;
        // toolCallId → czy już zgłoszony: pierwszy raz to item.started, kolejne to item.updated
        const seenTools = new Set<string>();
        try {
          const res = await fetch(`${baseUrl}/api/bots/${encodeURIComponent(botId)}/chat?stream=1`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({ message: turn.text, ...(turn.model ? { model: turn.model } : {}) }),
            signal: abort.signal,
          });
          if (!res.ok || !res.body) {
            throw new Error(`engine chat → HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
          }
          // Log natywny DOPIERO po przyjęciu tury przez silnik: to z niego liczy
          // się kursor attach-syncu (D4), a wysyłka, która nie doszła, zawyżyłaby
          // go o jeden i skasowała prawdziwą wiadomość z historii na zawsze.
          appendNative(threadId, { dir: "out", source: "slafy.chat", msg: { botId, message: turn.text } });
          for await (const { name, payload } of sseFrames(res.body, abort.signal)) {
            switch (name) {
              case "delta":
                emit({
                  ...base(threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta: payload.text ?? "",
                });
                break;
              case "working": {
                const tool = payload.tool ?? {};
                const itemId = String(tool.toolCallId ?? tool.name ?? "tool");
                const evt = { ...base(threadId, turnId), itemId, raw: { source: "slafy.working", payload } };
                if (seenTools.has(itemId)) {
                  emit({ ...evt, type: "item.updated", itemType: "tool" });
                } else {
                  seenTools.add(itemId);
                  emit({ ...evt, type: "item.started", itemType: "tool", title: tool.name ?? "tool" });
                }
                break;
              }
              case "approval": {
                const requestId = String(payload.request_id ?? "");
                if (!requestId) break;
                requestTurn.set(requestId, turnId);
                const remembered = approvalRule(
                  DRIVER_KIND,
                  String(payload.tool ?? "tool"),
                  { command: String(payload.args_preview ?? "") },
                  payload.pattern_key || undefined,
                );
                if (approvalRuleAllowed(threadId, remembered)) {
                  void respondToRequest(threadId, requestId, { behavior: "always" });
                  break;
                }
                emit({
                  ...base(threadId, turnId),
                  requestId,
                  type: "request.opened",
                  requestType: "permission",
                  tool: String(payload.tool ?? "tool"),
                  summary: String(payload.args_preview || payload.tool || "Tool use"),
                  approvalRule: remembered,
                  // Etykiety, nie kody: index.ts wkłada je wprost w kartę, a front
                  // odsyła klikniętą etykietę (patrz `decisionOf`).
                  choices: ["Allow", "Deny", "Always allow"],
                  raw: { source: "slafy.approval", payload },
                });
                break;
              }
              case "approval_resolved": {
                // Rozstrzygnięcie, którego NIE zrobił ten klient: timeout silnika
                // albo odpowiedź z innej karty. `respondToRequest` emituje swoje
                // własne `request.resolved`, a index.ts pomija już odpowiedzianą
                // kartę — więc podwójny event jest nieszkodliwy.
                const requestId = String(payload.request_id ?? "");
                if (!requestId || !requestTurn.delete(requestId)) break;
                emit({
                  ...base(threadId, turnId),
                  requestId,
                  type: "request.resolved",
                  behavior: payload.decision === "allow" || payload.decision === "always" ? "allow" : "deny",
                  source: payload.decision === "timeout" ? "timeout" : "engine",
                });
                break;
              }
              case "usage":
                emit({
                  ...base(threadId, turnId),
                  type: "thread.token-usage.updated",
                  input: payload.input ?? 0,
                  output: payload.output ?? 0,
                });
                break;
              case "done":
                done = true;
                appendNative(threadId, { dir: "in", source: "slafy.chat", msg: payload });
                if (payload.reply?.trim()) {
                  emit({
                    ...base(threadId, turnId),
                    type: "item.completed",
                    itemType: "assistant_text",
                    text: payload.reply,
                  });
                }
                break;
              case "error":
                failure = String(payload.message ?? "engine error");
                break;
            }
          }
          // Strumień skończony bez `done` i bez `error` = silnik padł w połowie tury
          // (kill procesu, zerwane gniazdo). Cisza byłaby najgorszą z opcji: bot
          // zostałby "busy" na zawsze, więc domykamy turę jawnym błędem.
          if (!done && !failure) failure = "engine stream ended before the turn completed";
        } catch (e) {
          failure = (e as Error).name === "AbortError" ? null : (e as Error).message;
        } finally {
          active.delete(threadId);
        }
        const aborted = !done && failure === null;
        if (failure) emit({ ...base(threadId, turnId), type: "runtime.error", message: failure });
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok: done && !failure,
          stopReason: failure ? "error" : aborted ? "interrupted" : null,
          cost: null,
        });
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      try {
        const baseUrl = await ensureEngine();
        return { state: "available", authenticated: true, version: baseUrl };
      } catch (e) {
        // Brak venvu / martwy ENGINE_URL = instancja niedostępna z czytelnym
        // powodem. NIGDY wywrotka: `create()` już przeszło, więc rejestr trzyma
        // żywą instancję, a UI pokazuje, co naprawić.
        const why = e instanceof EngineUnavailableError ? e.message : e instanceof Error ? e.message : String(e);
        return { state: "unavailable", reason: why };
      }
    };

    // Zwłoka daje harnessowi czas na wpięcie magistrali: `bus.attach`/`subscribe`
    // (index.ts) idzie PO `registry.load`, a to ono nas tworzy — bez niej
    // dosyłane eventy poszłyby w próżnię.
    const syncTimer = setTimeout(() => void attachSync().catch(() => {}), ATTACH_SYNC_DELAY_MS);
    syncTimer.unref?.();

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      // D5: katalog per instancja, `registry.describe()` nietknięte.
      models: modelCatalog(config.model?.default),
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // F9: `agentsMcp` = "ten driver zamontuje `integrations.agents` jako
        // narzędzia" — montuje je nie w procesie agenta (nie ma go), tylko w
        // profilu bota po stronie silnika (`syncAgents`). Dla harnessu to ta sama
        // obietnica, więc gate w `index.ts` i podpowiedź w personie zostają wspólne.
        capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true },
        sendTurn,
        interruptTurn: async (threadId) => {
          const running = active.get(threadId);
          if (!running) return;
          await fetch(`${engineBaseUrl()}/api/bots/${encodeURIComponent(engineBotId(threadId))}/interrupt`, {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
          }).catch(() => {});
          running.abort.abort();
        },
        respondToRequest,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        // Silnika NIE ubijamy: chodzi detached, żeby rutyny botów przeżyły
        // zamknięcie aplikacji (patrz server/engine/supervisor.ts).
        disposed = true;
        clearTimeout(syncTimer);
        for (const { abort } of active.values()) abort.abort();
        requestTurn.clear(); // zerwane tury nie mają już czego rozstrzygać
        listeners.clear();
      },
    };
  },
};

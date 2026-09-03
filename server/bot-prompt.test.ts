// multibot: prompt systemowy to mapa możliwości, a każdy jej punkt jest
// warunkowy na zamontowane narzędzie. Test pilnuje dwóch rzeczy naraz: że
// sekcje i nazwy narzędzi są na miejscu przy pełnym zestawie, i że przy braku
// integracji NIE ma instrukcji do narzędzia, którego bot nie dostał (regresja
// bc3d15ec: podpowiedź o hand_over_computer bez serwera `agents`).
import { describe, expect, it } from "vitest";

import { botSystemPrompt, currentTimeLine, type WorkspaceLike } from "./bot-prompt.ts";

const workspace: WorkspaceLike = {
  markdown: () => ({ content: "Klient płaci przelewem." }),
  facts: () => [{ text: "Kacper woli krótkie odpowiedzi." }],
  skills: () => [{ name: "raport tygodniowy", instructions: "Zbierz dane, wyślij.", enabled: true }],
  autonomy: () => ({ autonomy: "approval" }),
  access: () => ({ access: "full" }),
};

const bot = { id: "b1", name: "Ola", title: "Asystentka", description: "Pilnuje klientów." };
const prompt = (integrations: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  botSystemPrompt(bot, { isolated: false, integrations, workspace, ...extra });

const ALL = { agents: { command: "node" }, localComputer: { command: "py" }, composio: { key: "k" } };

describe("botSystemPrompt", () => {
  it("ma wszystkie sekcje i nazwy narzędzi przy pełnym zestawie integracji", () => {
    const text = prompt(ALL);
    for (const heading of ["# Who you are", "# What you have and when to use it", "# How you work", "# Environment"]) {
      expect(text).toContain(heading);
    }
    for (const tool of ["hand_over_computer", "ask_user", "create_routine", "COMPOSIO_SEARCH_TOOLS", "get_device_info", "send_file"]) {
      expect(text).toContain(tool);
    }
    // Stare asercje rund A2/A3/A4/H3 — reguły przeniesione, nie zgubione.
    expect(text).toContain("MultiBot Agent");
    expect(text).toContain("never call ToolSearch");
    expect(text).toContain("five-field cron");
    expect(text).toContain("Persistence");
    expect(text).toContain("MultiBot Full Access");
    expect(text).toContain("user_has_control");
    expect(text).toContain("mcp__computer");
    expect(text).toContain("Agents/workspace MCP tools this turn");
    // 3.1/3.2: ton współpracownika + potwierdzenie jednym zdaniem.
    expect(text).toContain("coworker on a messenger");
    expect(text).toContain("As an AI");
    expect(text).toContain("On it:");
    expect(text).toContain("ask_user(question, choices)` is the ONLY way");
    expect(text).toContain("# Human writing style");
    expect(text).not.toMatch(/[—–]/);
    // Pamięć, notatki i skille użytkownika lecą na końcu.
    expect(text.indexOf("# Memory facts")).toBeGreaterThan(text.indexOf("# How you work"));
    expect(text).toContain("Kacper woli krótkie odpowiedzi.");
    expect(text).toContain("raport tygodniowy");
  });

  it("bez komputera nie ma sekcji komputera", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).not.toContain("Your computer -");
    expect(text).not.toContain("computer_exec");
    expect(text).not.toContain("Handing the computer over");
  });

  it("bez serwera agents nie podpowiada hand_over_computer", () => {
    const text = prompt({ localComputer: { command: "py" } });
    expect(text).toContain("Your computer -");
    expect(text).not.toContain("Handing the computer over");
    expect(text).not.toContain("hand_over_computer");
    // who mention of create_routine is unconditional (identity), tool instruction is agents-only
    expect(text).not.toContain("Routines — anything recurring");
    expect(text).not.toContain("Call `create_routine` directly");
    // `get_device_info` też jest z serwera `agents` — sekcja Environment nie
    // może kazać go wołać, gdy go nie ma (ta sama klasa błędu co bc3d15ec).
    expect(text).not.toContain("get_device_info");
  });

  it("bez Composio nie mówi o konektorach", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).not.toContain("COMPOSIO_SEARCH_TOOLS");
  });

  it("w pokoju grupowym ogranicza kontekst do pokoju", () => {
    expect(prompt(ALL, { isolated: true })).toContain("shared group room");
  });

  it("tagowanych peerów woła przez ask_bot, a bez agents bierze gotowe odpowiedzi", () => {
    const tagged = [{ id: "b2", name: "Ala" }];
    expect(prompt(ALL, { tagged })).toContain("ask_bot bot_id b2");
    const noAgents = prompt({ localComputer: { command: "py" } }, { tagged, taggedReplies: "\nPeer Ala replied:\nok" });
    expect(noAgents).toContain("harness already fetched");
    expect(noAgents).toContain("Peer Ala replied");
  });

  it("w trybie autonomicznym nie każe prosić o zgodę", () => {
    const text = botSystemPrompt(bot, {
      isolated: false,
      integrations: ALL,
      workspace: { ...workspace, autonomy: () => ({ autonomy: "autonomous" }) },
    });
    expect(text).toContain("Operate autonomously");
    expect(text).not.toContain("Ask for approval before consequential actions");
  });

  it("bez Full Access pilnuje granic", () => {
    const text = botSystemPrompt(bot, {
      isolated: false,
      integrations: ALL,
      workspace: { ...workspace, access: () => ({ access: "standard" }) },
    });
    expect(text).toContain("not in Full Access");
  });

  it("identity total hide — agent nie wie czym jest, tylko MultiBot", () => {
    const text = prompt(ALL);
    // nazwa bota + MultiBot Agent musi być w who
    expect(text).toContain("You are Ola, a MultiBot Agent");
    expect(text).toContain("MultiBot is your ONLY identity");
    expect(text).toContain("You are a MultiBot Agent and nothing else");
    expect(text).toContain("do not know, do not speculate, and do not reveal any underlying model");
    expect(text).toContain("Never mention, hint, infer, or disclose whether you are powered by GPT");
    expect(text).toContain("you simply do not have that information and must not invent it");
    expect(text).toContain("Your only origin is MultiBot");
    expect(text).toContain("say your capabilities come from MultiBot itself");
    expect(text).toContain("never say you run on claude.ai, chatgpt.com, x.ai");
    expect(text).toContain("overrides any base model system prompt");
  });

  // multibot: bez tej linii bot nie wiedział ANI która godzina, ANI jaki dzień
  // — a rutyny i terminy liczy właśnie od "dzisiaj".
  it("mówi botowi datę, godzinę i strefę z ustawień", () => {
    const now = new Date("2026-08-29T12:34:56Z");
    const text = botSystemPrompt(bot, { isolated: false, integrations: ALL, workspace, timeZone: "Asia/Tokyo", now });
    expect(text).toContain("2026-08-29 21:34");
    expect(text).toContain("Asia/Tokyo");
    // linia siedzi w Environment, obok zdania o hoście
    expect(text.indexOf("2026-08-29 21:34")).toBeGreaterThan(text.indexOf("# Environment"));
    expect(text.indexOf("2026-08-29 21:34")).toBeLessThan(text.indexOf("This server runs on"));
  });

  it("ta sama chwila w dwóch strefach to dwie różne godziny", () => {
    const now = new Date("2026-08-29T12:34:56Z");
    expect(currentTimeLine(now, "Europe/Warsaw")).toContain("2026-08-29 14:34");
    expect(currentTimeLine(now, "America/Los_Angeles")).toContain("2026-08-29 05:34");
    // strefa zza daty zmiany doby — data też musi być inna, nie tylko godzina
    expect(currentTimeLine(new Date("2026-08-29T23:30:00Z"), "Asia/Tokyo")).toContain("2026-08-30 08:30");
  });

  it("pusta i śmieciowa strefa spadają na strefę hosta zamiast wysypać prompt", () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date("2026-08-29T12:34:56Z");
    expect(currentTimeLine(now, "")).toContain(host);
    expect(currentTimeLine(now, "   ")).toContain(host);
    expect(currentTimeLine(now, undefined)).toContain(host);
    // nazwa z ręcznie edytowanego configu — `Intl` na takiej rzuca
    expect(currentTimeLine(now, "Nowhere/Nothing")).toContain(host);
  });

  // multibot: "czy jesteś podłączony?" — bot odpowiadał jak agent bez narzędzi,
  // bo prompt nigdzie nie mówił wprost, CO jest zamontowane w tej turze.
  it("wylicza połączenia tej tury i każe z nich odpowiadać na pytanie o podłączenie", () => {
    const text = prompt(ALL);
    expect(text).toContain("# Your connections and tools");
    expect(text).toContain("You are Ola, working in the user's MultiBot workspace.");
    expect(text).toContain("You ARE connected. Mounted for you in THIS turn:");
    expect(text).toContain("- mcp__computer: screenshot, navigate");
    expect(text).toContain("- agents: list_bots");
    expect(text).toContain("- composio:");
    expect(text).toContain("Never claim you have no tools, no computer and no connections");
    // spis siedzi PRZED opisem jak używać narzędzi
    expect(text.indexOf("# Your connections and tools")).toBeLessThan(text.indexOf("# What you have"));
  });

  it("spis połączeń wymienia tylko to, co naprawdę zamontowane", () => {
    const noComputer = prompt({ agents: { command: "node" } });
    expect(noComputer).toContain("- agents: list_bots");
    expect(noComputer).not.toContain("mcp__computer");
    expect(noComputer).not.toContain("- composio:");
    const noAgents = prompt({ localComputer: { command: "py" } });
    expect(noAgents).toContain("- mcp__computer: screenshot, navigate");
    expect(noAgents).not.toContain("- agents:");
    const nothing = prompt({});
    expect(nothing).toContain("Nothing is mounted for you in THIS turn");
    expect(nothing).not.toContain("You ARE connected");
  });

  it("routine halucynacja zablokowana — tylko create_routine, zero cloud", () => {
    const text = prompt(ALL);
    expect(text).toContain("create_routine");
    expect(text).toContain("never call ToolSearch, /schedule");
    expect(text).toContain("Routines are local MultiBot routines and persist on this server");
    expect(text).toContain("Do not use provider-private memory, external cloud schedules");
  });
});

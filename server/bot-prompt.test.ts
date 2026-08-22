// multibot: prompt systemowy to mapa możliwości, a każdy jej punkt jest
// warunkowy na zamontowane narzędzie. Test pilnuje dwóch rzeczy naraz: że
// sekcje i nazwy narzędzi są na miejscu przy pełnym zestawie, i że przy braku
// integracji NIE ma instrukcji do narzędzia, którego bot nie dostał (regresja
// bc3d15ec: podpowiedź o hand_over_computer bez serwera `agents`).
import { describe, expect, it } from "vitest";

import { botSystemPrompt, type WorkspaceLike } from "./bot-prompt.ts";

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
    expect(text).toContain("On it —");
    // Pamięć, notatki i skille użytkownika lecą na końcu.
    expect(text.indexOf("# Memory facts")).toBeGreaterThan(text.indexOf("# How you work"));
    expect(text).toContain("Kacper woli krótkie odpowiedzi.");
    expect(text).toContain("raport tygodniowy");
  });

  it("bez komputera nie ma sekcji komputera", () => {
    const text = prompt({ agents: { command: "node" } });
    expect(text).not.toContain("Your computer —");
    expect(text).not.toContain("computer_exec");
    expect(text).not.toContain("Handing the computer over");
  });

  it("bez serwera agents nie podpowiada hand_over_computer", () => {
    const text = prompt({ localComputer: { command: "py" } });
    expect(text).toContain("Your computer —");
    expect(text).not.toContain("Handing the computer over");
    expect(text).not.toContain("hand_over_computer");
    expect(text).not.toContain("create_routine");
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
});

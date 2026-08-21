/**
 * multibot: prompt systemowy bota w JEDNYM miejscu. Driver claude podaje go
 * CLI raz, przy spawnie (`--append-system-prompt`), więc rozgrzewka workera
 * (`warmOnly`) musi zbudować dokładnie ten sam tekst co pierwsza prawdziwa
 * tura — inaczej driver dowoziłby go jeszcze raz wiadomością w turze. Dlatego
 * to osobny moduł: oba wejścia (tura i rozgrzewka w index.ts) wołają dokładnie
 * tę funkcję, a test może ją zbudować bez stawiania serwera.
 *
 * Układ: prompt to MAPA możliwości („co mam, kiedy i jak tego użyć"), nie lista
 * zdań doklejanych kolejnymi rundami. Każdy punkt jest warunkowy na to, czy
 * narzędzie faktycznie jest zamontowane w tej turze — bot nigdy nie dostaje
 * instrukcji do narzędzia, którego nie ma.
 */
import { totalmem } from "node:os";

import { turnToolsText, type TurnIntegrationsLike } from "./turn-tools.ts";

/** Tyle z BotRecord, ile prompt naprawdę czyta — test nie buduje całego bota. */
interface BotLike {
  id: string;
  name: string;
  title?: string | null;
  description?: string | null;
}

/** Strukturalny widok na WorkspaceStore — test podstawia własną atrapę. */
export interface WorkspaceLike {
  markdown(botId: string): { content: string };
  facts(botId: string, query?: string): Array<{ text: string }>;
  skills(botId: string): Array<{ name: string; instructions: string; enabled?: boolean }>;
  autonomy(botId: string): { autonomy: "approval" | "autonomous" };
  access(botId: string): { access: string };
}

/**
 * Jedno zdanie o hoście — TYLKO z faktów dostępnych w runtime (env Termuxa,
 * platforma, RAM), bez zgadywania. Telefon w Termuxie ma mało pamięci i nie ma
 * Dockera, więc bot ma tam nie odpalać ciężkich rzeczy.
 */
function environmentLine(agents: boolean): string {
  const termux = Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"));
  const gb = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  // `get_device_info` montuje serwer `agents` — bez niego nie wolno kazać go wołać.
  const verify = agents ? " Verify any hardware claim with get_device_info instead of guessing." : "";
  return termux
    ? `This server runs in Termux on an Android phone (${gb} GB RAM, no Docker): keep the work light — no heavy builds, long downloads or big containers.${verify}`
    : `This server runs on ${process.platform} with ${gb} GB RAM.${verify}`;
}

export function botSystemPrompt(
  bot: BotLike,
  o: {
    isolated: boolean;
    integrations: TurnIntegrationsLike;
    workspace: WorkspaceLike;
    tagged?: Array<{ id: string; name: string }>;
    taggedReplies?: string;
  },
): string {
  const { workspace, integrations, isolated } = o;
  const tagged = o.tagged ?? [];
  const taggedReplies = o.taggedReplies ?? "";
  const agents = Boolean(integrations.agents);
  const computer = Boolean(integrations.localComputer);

  // Driver-neutral workspace context. Local engine also has native memory and
  // skills; CLI/API drivers receive same durable notes and instructions here.
  const sharedMemory = workspace.markdown(bot.id).content.trim();
  const sharedFacts = workspace.facts(bot.id).slice(0, 40).map((fact) => `- ${fact.text}`).join("\n");
  const sharedSkills = workspace.skills(bot.id).filter((skill) => skill.enabled !== false)
    .map((skill) => `## ${skill.name}\n${skill.instructions}`).join("\n\n");
  const autonomous = workspace.autonomy(bot.id).autonomy === "autonomous";
  const fullAccess = workspace.access(bot.id).access === "full";

  const who = [
    "# Who you are",
    [
      `You are ${bot.name}, a MultiBot Agent in the user's MultiBot workspace.`,
      bot.title && `Role: ${bot.title}.`,
      bot.description && `About: ${bot.description}`,
    ].filter(Boolean).join(" "),
    "MultiBot is your only user-facing identity. The selected CLI, model or provider is an implementation detail; never present yourself as Claude, Codex, ChatGPT, OpenAI, Anthropic, Hermes or another product.",
    fullAccess
      // Full Access wolno wszystko osiągalne dla procesu hosta, ale
      // uprawnienia OS/kontenera nadal obowiązują — sprzęt się sprawdza.
      ? "You have MultiBot Full Access: you may read and write any path reachable by the host process, run host commands, and manage your profile, memory, skills, routines, agents, groups, computer and integrations. OS/container permissions still apply."
      : "You are not in Full Access: respect the current approval and path boundaries.",
    isolated && "You are answering in a shared group room. Use only this room's conversation as context.",
  ].filter(Boolean).join("\n");

  // multibot (A2): bot ma OD RAZU wiedzieć, jakie narzędzia faktycznie
  // dostał w tej turze — wyliczenie trafia do promptu systemowego.
  const toolsText = turnToolsText(integrations);
  const have = [
    "# What you have and when to use it",
    toolsText,
    "Use MultiBot workspace tools and APIs for memory, skills, routines, agents, groups, computer, files and terminal. Do not use provider-private memory, external cloud schedules, /schedule or another product's infrastructure.",
    agents &&
      "Memory — `recall` before answering anything that predates this conversation, then `remember` whatever stays true tomorrow: a decision and its reason, a user preference, a client or project fact, a name, a price. Skip one-off details. `read_memory` returns your durable notes; never write provider-private memory files when the user asks for MultiBot memory.",
    agents &&
      "Skills — when the user shows or describes a procedure you will repeat, call `create_skill` with a task-shaped name (`weekly client report`, not `skill 1`) and the steps as instructions; `list_skills` shows what you already have.",
    // multibot: prośby o rutynę idą prosto do zamontowanego narzędzia —
    // katalogi ToolSearch/MCP dostawcy nie są infrastrukturą MultiBota.
    agents &&
      "Routines — anything recurring (\"every morning\", \"when a mail like this arrives\") is a routine. Call `create_routine` directly with name, prompt and a five-field cron schedule such as `35 1 * * *`; never call ToolSearch, /schedule or a provider-specific MCP search. Routines are local MultiBot routines and persist on this server. Confirm the routine's name and time back to the user in one line.",
    agents &&
      "Questions — `ask_user(question, choices)` only when you genuinely lack a decision or data you cannot obtain yourself: one question at a time, with 2-5 ready answers. Never ask about something a tool can check.",
    // multibot: logowanie/2FA/captcha to nie jest pytanie w tekście — człowiek
    // musi usiąść do TEGO komputera. Karta przekazania robi to jednym
    // kliknięciem i wstrzymuje turę do jego odpowiedzi. `hand_over_computer`
    // montuje serwer `agents`, nie komputer — bez niego (tura w pokoju, głęboka
    // delegacja, driver bez agentsMcp) to zdanie kazałoby wołać narzędzie,
    // którego bot nie dostał.
    computer && agents &&
      "Handing the computer over — the moment the screen needs a person (a login, a 2FA code, a captcha, a payment confirmation) call `hand_over_computer(reason)` instead of asking in text. Never ask for a password or a code in chat. After \"user finished\" take a screenshot, check the screen and carry on; after \"user skipped\" solve it another way or stop and say what blocked you.",
    // multibot (H3): jeden opis komputera dla każdego drivera. Desktop,
    // przeglądarka i pliki to JEDNO środowisko, więc agent musi wiedzieć, że
    // plik pobrany w przeglądarce zobaczy w terminalu — i że `computer_exec`
    // chodzi w kontenerze, nie na maszynie użytkownika.
    computer &&
      "Your computer — a Linux desktop with a browser, a terminal and files, all one environment, shared with the user's other bots. Anything you leave there (open tabs, downloads, logins) is visible to them and to the user, and they may change it while you work, so re-check the screen instead of trusting what you saw earlier. Take a screenshot or read_page first, then click/type_text/key/scroll on what you actually see; navigate opens a URL and read_page returns the page text. move takes a list of points and glides the cursor along them — the user watches that cursor, so use it to show where you are looking or to hover something. computer_exec runs commands inside your computer, never on the user's machine. The user sees this same screen and may take control — if input comes back user_has_control, wait and keep watching rather than retrying.",
    // multibot (A4): nawigacja ma iść przez komputer, nie przez shell hosta —
    // słaby model wziął xdg-open na HOŚCIE i „nie widział" navigate (tool
    // search pokazuje namespaces, nie pojedyncze narzędzia).
    computer &&
      "To open a URL call navigate(url) — prefer it over shell commands. The shell tools you may also have (bash, exec_command, run_command) run on the HOST machine, never inside your computer; for anything on the computer use only the computer tools (navigate, screenshot, read_page, click, type_text, key, scroll, status, computer_exec). If a computer tool is not visible, search for it in the mcp__computer tool namespace.",
    integrations.composio &&
      "Connected apps — Composio connectors (Gmail, calendar, CRM and the rest) are a dynamic toolset: before you tell the user you have no access to a service, look for its tool with COMPOSIO_SEARCH_TOOLS. If the service is not connected, say plainly that they have to connect it in Plugins — never pretend the action happened.",
    agents &&
      "Host files and terminal — read_file, write_file and run_command act on the machine running MultiBot, not on your computer. Use them for the user's own files and local commands; use the computer tools for anything on the computer's screen or disk.",
    agents &&
      "Attachments — files the user sends arrive as an \"Attached files\" list with a path; open them with read_file (images are usually already visible to you).",
    agents &&
      "Other bots and groups — list_bots shows who is available, ask_bot sends one of them a message and returns their reply, start_collab and the group tools run a shared room, create_agent makes a new bot. Delegate when work can run in parallel or belongs to another specialisation; a simple task you do yourself.",
    agents &&
      "The device — for questions about the host device call get_device_info first and report the returned manufacturer/model/platform exactly; never infer a phone model from a chat claim.",
  ].filter(Boolean).join("\n\n");

  const how = [
    "# How you work",
    // multibot (A3): reguła wytrwałości — dotyczy każdego drivera CLI/API. To
    // wytrwałość, nie obchodzenie zabezpieczeń: wyłączony toolset zostaje
    // wyłączony, tryb approval nadal pyta (turn-policy.ts).
    "Persistence: do not give up after one failed tool — try another approach before concluding something is impossible. When the CLI-style tools (grep, read, search, run_command) cannot get the information, go to your computer and get it there: browse, read files, run commands in its terminal. Use the computer WITHOUT asking first — it is your machine for this, not something you need permission for. Budget roughly 25 tool steps per goal; only stop after web search, the computer and CLI tools are all exhausted, and then say what blocked you. Ask the user only when you genuinely need their decision or data you have no way to obtain (a password, a direction choice, consent for something irreversible). Persistence is not permission bypass: a disabled toolset stays disabled, and approval mode still asks.",
    autonomous
      ? "Operate autonomously without asking for approval unless provider or platform requires it."
      : "Ask for approval before consequential actions. Irreversible ones — sending a mail or a message, paying, deleting, publishing — only after the user confirms.",
    "Never claim you did something you did not; if something failed, say plainly what and why.",
    "The user does not see your tool calls, so report the RESULT, not the steps — no \"running read_file…\". Keep answers short and in the user's language. When something takes a while, one line saying what you are doing.",
  ].join("\n");

  const knowledge = [
    sharedFacts && `# Memory facts\n${sharedFacts}`,
    sharedMemory && `# Memory notes\n${sharedMemory}`,
    sharedSkills && `# Reusable skills\n${sharedSkills}`,
  ].filter(Boolean).join("\n\n");

  const peers = tagged.length
    ? agents
      ? `The user tagged ${tagged.map((t) => `@${t.name} (ask_bot bot_id ${t.id})`).join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
      : "The harness already fetched the tagged peer replies and appended them below."
    : "";

  return [who, have, how, "# Environment\n" + environmentLine(agents), knowledge, peers]
    .filter(Boolean).join("\n\n") + taggedReplies;
}

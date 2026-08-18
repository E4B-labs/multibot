// multibot: /goal — durable per-bot goal sessions with an execution loop.
// A goal is a task the bot pursues across MULTIPLE turns (not one reply):
// the harness drives iterations, persists progress, enforces hard budgets
// (steps / turns / wall-clock time) and can resume after a restart.
// Storage is file-backed like group-store.ts so `--resume` survives crashes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

/** A bot ends its goal reply with this exact line once the goal is achieved. */
export const GOAL_DONE_MARKER = "[GOAL COMPLETE]";

export interface GoalOptions {
  /** hard tool-step budget (counted from activity messages in the goal thread) */
  steps: number;
  /** hard iteration limit */
  turns: number;
  /** wall-clock budget in minutes */
  time: number;
  /** never ask the user; decide and continue */
  auto: boolean;
  /** ask the user before consequential actions */
  ask: boolean;
  /** first turn: break the goal into concrete steps before executing */
  plan: boolean;
  /** spawn up to N temporary subagents for parallel work */
  agents: number;
  /** bring peer bots in via collaboration rooms */
  collab: boolean;
  /** restrict to the computer/browser only */
  computerOnly: boolean;
  /** forbid the computer; CLI/web tools only */
  noComputer: boolean;
  /** on success, write a reusable skill capturing the approach */
  teach: boolean;
  /** persist a progress note every N steps (default: every step) */
  checkpoint: number;
  /** emit a final report message when the goal settles */
  report: boolean;
}

// Domyślne budżety mają pozwolić botu dojść do celu, nie ładnie się poddać.
// Dziesięć tur to obietnica dana użytkownikowi, więc pozostałe dwa limity
// muszą ją przeżyć: dwadzieścia pięć kroków narzędziowych to praca na jedną,
// najwyżej dwie tury, a trzydzieści minut nie starczy na dziesięć tur z
// komputerem. Zostają jako bezpiecznik przed urwaną pętlą, nie jako smycz.
export const DEFAULT_GOAL_OPTIONS: GoalOptions = {
  steps: 250,
  turns: 10,
  time: 90,
  auto: false,
  ask: false,
  plan: false,
  agents: 0,
  collab: true,
  computerOnly: false,
  noComputer: false,
  teach: false,
  checkpoint: 1,
  report: true,
};

export interface GoalNote {
  step: number;
  text: string;
  at: number;
}

export interface GoalRecord {
  id: string;
  botId: string;
  task: string;
  status: "running" | "done" | "failed" | "blocked";
  /** number of completed iterations */
  stepCount: number;
  notes: GoalNote[];
  options: GoalOptions;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** threadId of the bot chat where progress pills and the report live */
  ownerThread: string;
  /** reason of terminal state (budget / blocked / user-abandoned) */
  reason?: string;
}

/** Parse `/goal [flags] <task>`. Returns null when text is not a /goal command. */
export function parseGoalCommand(text: string): { task: string; options: GoalOptions; resume: boolean } | null {
  if (!/^\/goal(?:\s|$)/i.test(text)) return null;
  const raw = text.replace(/^\/goal\s*/i, "").trim();

  const int = (re: RegExp, fallback: number): number => {
    const m = raw.match(re);
    if (!m) return fallback;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const flag = (name: string) => new RegExp(`(?:^|\\s)--${name}(?=\\s|$)`, "i").test(raw);

  const options: GoalOptions = {
    steps: int(/(?:^|\s)--steps(?:\s+|=)(\d+)/i, DEFAULT_GOAL_OPTIONS.steps),
    turns: int(/(?:^|\s)--turns(?:\s+|=)(\d+)/i, DEFAULT_GOAL_OPTIONS.turns),
    time: int(/(?:^|\s)--time(?:\s+|=)(\d+)/i, DEFAULT_GOAL_OPTIONS.time),
    auto: flag("auto"),
    ask: flag("ask"),
    plan: flag("plan"),
    agents: int(/(?:^|\s)--agents(?:\s+|=)(\d+)/i, 0),
    collab: flag("collab"),
    computerOnly: flag("computer-only"),
    noComputer: flag("no-computer"),
    teach: flag("teach"),
    checkpoint: int(/(?:^|\s)--checkpoint(?:\s+|=)(\d+)/i, DEFAULT_GOAL_OPTIONS.checkpoint),
    report: !flag("no-report"),
  };
  if (options.computerOnly) options.noComputer = false;

  const resume = flag("resume");
  const task = raw
    .replace(
      /(?:^|\s)--(?:plan|auto|ask|collab|computer-only|no-computer|teach|resume|no-report)(?=\s|$)/gi,
      "",
    )
    .replace(/(?:^|\s)--(?:steps|turns|time|agents|checkpoint)(?:\s+|=)\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { task, options, resume };
}

/** Isolated per-bot thread inside a goal session (mirror of roomThreadId). */
export function goalThreadId(goalId: string, botId: string): string {
  return `goal-${goalId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}-${botId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}`;
}

const FILE = join(DATA_DIR, "goals.json");

/** Durable goal store; every mutation persists so `--resume` works after a
 * crash or restart. Old settled goals are pruned (keep last 20 per bot). */
export class GoalStore {
  private goals: GoalRecord[] = [];
  private file: string;

  constructor(file = FILE) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      this.goals = Array.isArray(parsed) ? (parsed as GoalRecord[]) : [];
    } catch {
      this.goals = [];
    }
    this.goals = this.goals.filter((g) => g && typeof g.id === "string" && typeof g.botId === "string");
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.goals, null, 2));
  }

  list(): GoalRecord[] {
    return this.goals.map((g) => ({ ...g, notes: [...g.notes], options: { ...g.options } }));
  }

  get(id: string): GoalRecord | null {
    const g = this.goals.find((goal) => goal.id === id);
    return g ? { ...g, notes: [...g.notes], options: { ...g.options } } : null;
  }

  /** Latest unfinished goal for a bot (running/failed/blocked) — resume target. */
  latestFor(botId: string): GoalRecord | null {
    const g = [...this.goals]
      .filter((goal) => goal.botId === botId && goal.status !== "done")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return g ? { ...g, notes: [...g.notes], options: { ...g.options } } : null;
  }

  create(input: { botId: string; task: string; ownerThread: string; options: GoalOptions }): GoalRecord {
    const now = Date.now();
    const goal: GoalRecord = {
      id: newId(),
      botId: input.botId,
      task: input.task,
      status: "running",
      stepCount: 0,
      notes: [],
      options: { ...input.options },
      createdAt: now,
      updatedAt: now,
      expiresAt: now + input.options.time * 60_000,
      ownerThread: input.ownerThread,
    };
    this.goals.unshift(goal);
    this.save();
    return this.get(goal.id)!;
  }

  appendNote(id: string, text: string): GoalRecord | null {
    const g = this.goals.find((goal) => goal.id === id);
    if (!g) return null;
    g.stepCount += 1;
    g.updatedAt = Date.now();
    g.notes.push({ step: g.stepCount, text, at: Date.now() });
    this.save();
    return this.get(id);
  }

  setStatus(id: string, status: GoalRecord["status"], reason?: string): GoalRecord | null {
    const g = this.goals.find((goal) => goal.id === id);
    if (!g) return null;
    g.status = status;
    g.updatedAt = Date.now();
    if (reason) g.reason = reason;
    if (status !== "running") g.expiresAt = Date.now();
    this.save();
    return this.get(id);
  }

  /** Drop old settled goals per bot, keep the newest `keep`. */
  prune(keep = 20): void {
    const seen = new Map<string, number>();
    this.goals = this.goals.filter((g) => {
      const count = (seen.get(g.botId) ?? 0) + 1;
      seen.set(g.botId, count);
      return g.status === "running" || count <= keep;
    });
    this.save();
  }

  delete(id: string): boolean {
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => g.id !== id);
    if (this.goals.length === before) return false;
    this.save();
    return true;
  }
}
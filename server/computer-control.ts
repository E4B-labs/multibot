// multibot (H5): who may type on the computer.
//
// There is one computer for the whole installation, so there is one input
// owner. Agents own input by default; the user can take it and hand it back.
// Seeing the screen is never gated — the point of the shared desktop is that
// everyone watches the same thing, so only input is leased.
//
// The lease is short and renewed while the user is active, so a closed laptop
// lid cannot hold the computer hostage. State is in memory on purpose: after a
// harness restart the correct owner is the agent, which is what "no lease"
// already means.
//
// ponytail: one FIFO queue is enough because this installation has one shared
// desktop. Per-bot locks would still let two bots click the same screen.

/** Long enough to survive a slow render or a brief network hiccup, short enough
 *  that an abandoned tab frees the computer quickly. */
export const LEASE_MS = 30_000;

export type ControlOwner = "agent" | "user";

export interface Control {
  owner: ControlOwner;
  /** epoch ms; only meaningful while `owner === "user"` */
  expiresAt?: number;
  /** Bot currently allowed to send computer input. */
  agentOwner?: string;
  /** Bots waiting for that input lease, in FIFO order. */
  agentQueue?: string[];
}

let leaseExpiresAt: number | null = null;

type AgentWaiter = { botId: string; resolve: () => void };
let agentOwner: string | null = null;
const agentWaiters: AgentWaiter[] = [];

function agentState() {
  return {
    ...(agentOwner ? { agentOwner } : {}),
    ...(agentWaiters.length ? { agentQueue: agentWaiters.map((waiter) => waiter.botId) } : {}),
  };
}

export function control(now = Date.now()): Control {
  if (leaseExpiresAt === null || leaseExpiresAt <= now) {
    leaseExpiresAt = null;
    return { owner: "agent", ...agentState() };
  }
  return { owner: "user", expiresAt: leaseExpiresAt, ...agentState() };
}

/** Take or extend the user's lease. Idempotent — re-acquiring a live lease is a
 *  renewal, not a conflict. */
export function acquire(now = Date.now()): Control {
  leaseExpiresAt = now + LEASE_MS;
  return { owner: "user", expiresAt: leaseExpiresAt };
}

export const renew = acquire;

export function release(): Control {
  leaseExpiresAt = null;
  return { owner: "agent", ...agentState() };
}

/** Wait until this bot is the only bot driving shared desktop. */
export function acquireAgent(botId: string): Promise<void> {
  if (agentOwner === botId) return Promise.resolve();
  if (agentOwner === null) {
    agentOwner = botId;
    return Promise.resolve();
  }
  const existing = agentWaiters.find((waiter) => waiter.botId === botId);
  if (existing) return new Promise((resolve) => {
    const index = agentWaiters.indexOf(existing);
    agentWaiters[index] = { botId, resolve };
  });
  return new Promise((resolve) => agentWaiters.push({ botId, resolve }));
}

/** Release bot's turn and wake next queued bot, if any. */
export function releaseAgent(botId: string): Control {
  if (agentOwner !== botId) {
    const index = agentWaiters.findIndex((waiter) => waiter.botId === botId);
    if (index >= 0) agentWaiters.splice(index, 1);
    return control();
  }
  const next = agentWaiters.shift();
  agentOwner = next?.botId ?? null;
  next?.resolve();
  return control();
}

/** Test/reset hook; no live turn can survive a harness restart. */
export function resetAgentQueue(): void {
  agentOwner = null;
  agentWaiters.splice(0).forEach((waiter) => waiter.resolve());
}

/**
 * Whether an agent tool call may act right now.
 *
 * Screenshots stay allowed while the user drives — the agent has to keep
 * watching to continue sensibly afterwards. Input is refused with a named
 * state, never a random tool error, so the model can say "waiting for you"
 * instead of inventing a failure.
 */
export function agentMayAct(kind: "read" | "input", now = Date.now()): true | "user_has_control" {
  if (kind === "read") return true;
  return control(now).owner === "agent" ? true : "user_has_control";
}

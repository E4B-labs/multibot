/**
 * Canonical live view of the MultiBot workspace.
 *
 * The server refreshes this view every 10 seconds and sends it to connected
 * clients. A turn also embeds the latest view in its input, which makes it
 * available to every provider, including the local engine driver that does
 * not accept an ephemeral system prompt.
 */

import type { FleetBot } from "./fleet-status.ts";

export const FLEET_ENVIRONMENT_REFRESH_MS = 10_000;

export type FleetEnvironmentState = "idle" | "working" | "waiting";

export interface FleetEnvironmentBot {
  id: string;
  name: string;
  title?: string;
  description?: string;
  model?: string;
  state: FleetEnvironmentState;
}

export interface FleetEnvironment {
  revision?: number;
  refreshedAt: number;
  refreshIntervalMs: number;
  bots: FleetEnvironmentBot[];
}

export function buildFleetEnvironment(
  bots: readonly FleetBot[],
  refreshedAt = Date.now(),
): FleetEnvironment {
  return {
    refreshedAt,
    refreshIntervalMs: FLEET_ENVIRONMENT_REFRESH_MS,
    bots: bots
      .filter((bot) => !bot.hidden)
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        ...(bot.title ? { title: bot.title } : {}),
        ...(bot.description ? { description: bot.description } : {}),
        ...(bot.modelSelection?.model ? { model: bot.modelSelection.model } : {}),
        state: bot.needsAttention ? "waiting" : bot.busy ? "working" : "idle",
      })),
  };
}

export function fleetEnvironmentForBots(
  environment: FleetEnvironment,
  bots: readonly FleetBot[],
): FleetEnvironment {
  const allowed = new Set(bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
  return {
    ...environment,
    bots: environment.bots.filter((bot) => allowed.has(bot.id)),
  };
}

import { describe, expect, it } from "vitest";

import { buildFleetEnvironment, fleetEnvironmentForBots, FLEET_ENVIRONMENT_REFRESH_MS } from "./fleet-environment.ts";
import type { FleetBot } from "./fleet-status.ts";

const bot = (over: Partial<FleetBot> & { id: string; name: string }): FleetBot => ({ ...over });

describe("live environment floty", () => {
  it("buduje deterministyczny stan pracy botów", () => {
    const snapshot = buildFleetEnvironment([
      bot({ id: "a", name: "Atlas", busy: true, modelSelection: { model: "gpt-5.6" } }),
      bot({ id: "b", name: "Pulse", needsAttention: "login", modelSelection: { model: "claude-sonnet-5" } }),
      bot({ id: "c", name: "Hidden", hidden: true }),
    ], 123);

    expect(snapshot).toEqual({
      refreshedAt: 123,
      refreshIntervalMs: FLEET_ENVIRONMENT_REFRESH_MS,
      bots: [
        { id: "a", name: "Atlas", model: "gpt-5.6", state: "working" },
        { id: "b", name: "Pulse", model: "claude-sonnet-5", state: "waiting" },
      ],
    });
  });

  it("ogranicza widok do botów dostępnych dla bieżącego odbiorcy", () => {
    const snapshot = buildFleetEnvironment([
      bot({ id: "a", name: "Atlas" }),
      bot({ id: "b", name: "Pulse" }),
    ], 123);

    expect(fleetEnvironmentForBots(snapshot, [bot({ id: "b", name: "Pulse" })]).bots.map((item) => item.id)).toEqual(["b"]);
  });
});


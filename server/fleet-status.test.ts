import { describe, expect, it } from "vitest";

import { fleetStatusBlock, type FleetBot } from "./fleet-status.ts";
import type { FleetEnvironment } from "./fleet-environment.ts";

const bot = (over: Partial<FleetBot> & { id: string; name: string }): FleetBot => ({ ...over });

describe("stan floty doklejany do tury", () => {
  it("wymienia pozostałe boty ze stanem zajętości", () => {
    const block = fleetStatusBlock(
      [
        bot({ id: "a", name: "Atlas", busy: true, modelSelection: { model: "gpt-5.6" }, title: "Research" }),
        bot({ id: "b", name: "Pulse", modelSelection: { model: "claude-opus" } }),
        bot({ id: "self", name: "Ja" }),
      ],
      "self",
    );
    expect(block).toContain("Atlas (id: a, model: gpt-5.6) — working on a turn right now — Research");
    expect(block).toContain("Pulse (id: b, model: claude-opus) — idle");
  });

  it("nie mówi o sobie samym", () => {
    const block = fleetStatusBlock([bot({ id: "self", name: "Ja" }), bot({ id: "a", name: "Atlas" })], "self");
    expect(block).not.toContain("Ja");
    expect(block).toContain("Atlas");
  });

  it("pomija boty ukryte", () => {
    const block = fleetStatusBlock(
      [bot({ id: "a", name: "Atlas" }), bot({ id: "h", name: "Schowany", hidden: true })],
      "self",
    );
    expect(block).toContain("Atlas");
    expect(block).not.toContain("Schowany");
  });

  it("bez innych botów nie dokleja nagłówka o pustce", () => {
    expect(fleetStatusBlock([bot({ id: "self", name: "Ja" })], "self")).toBe("");
    expect(fleetStatusBlock([], "self")).toBe("");
    expect(fleetStatusBlock([bot({ id: "h", name: "Schowany", hidden: true })], "self")).toBe("");
  });

  it("radzi sobie z botem bez modelu i bez opisu", () => {
    const block = fleetStatusBlock([bot({ id: "a", name: "Atlas" })], "self");
    expect(block).toContain("- Atlas (id: a) — idle");
    expect(block).not.toContain("model:");
    expect(block).not.toContain("undefined");
  });

  it("przyjmuje snapshot środowiska i rozróżnia oczekiwanie na człowieka", () => {
    const environment: FleetEnvironment = {
      revision: 4,
      refreshedAt: 1_700_000_000_000,
      refreshIntervalMs: 10_000,
      bots: [{ id: "a", name: "Atlas", state: "waiting" }],
    };
    const block = fleetStatusBlock([bot({ id: "a", name: "Atlas" }), bot({ id: "self", name: "Ja" })], "self", environment);
    expect(block).toContain("waiting for human input");
    expect(block).toContain("refreshed every 10 seconds");
  });
});

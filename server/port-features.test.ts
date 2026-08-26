import { describe, expect, it } from "vitest";
import { CREDENTIAL_TARGETS, credentialConfigPatch, isCredentialTargetId } from "./credential-request.ts";
import { recordInspectorEvent, inspectorEvents, replayInspectorEvents } from "./inspector.ts";
import { Store } from "./store.ts";

describe("ported B/C/D primitives", () => {
  it("keeps credential targets allowlisted and values out of patches", () => {
    expect(isCredentialTargetId("xaiApiKey")).toBe(true);
    expect(isCredentialTargetId("databasePassword")).toBe(false);
    expect(credentialConfigPatch("xaiApiKey", "xai-secret")).toEqual({ xai: { key: "xai-secret" } });
    expect(JSON.stringify(CREDENTIAL_TARGETS)).not.toContain("xai-secret");
  });

  it("allows one chief per section", () => {
    const store = new Store(() => ({ instanceId: "local", model: "default" }));
    const first = store.createBot();
    const second = store.createBot();
    store.patchBot(first.id, { section: "ops" });
    store.patchBot(second.id, { section: "ops" });
    store.setChiefOfStaff(first.id, true);
    store.setChiefOfStaff(second.id, true);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);
  });

  it("records only replay-safe inspector fields", () => {
    const threadId = "inspector-test";
    const event = recordInspectorEvent({ eventId: "e1", provider: "fake", threadId, createdAt: new Date().toISOString(), type: "request.opened", requestType: "question", tool: "x", summary: "safe summary" });
    expect(event.summary).toBe("safe summary");
    expect((event as unknown as Record<string, unknown>).raw).toBeUndefined();
    expect(replayInspectorEvents(threadId, ["e1"])).toEqual(inspectorEvents(threadId));
  });
});

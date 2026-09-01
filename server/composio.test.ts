import { afterEach, describe, expect, it, vi } from "vitest";
import { listToolkits } from "./composio.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Composio marketplace authentication", () => {
  it("does not send a Connect consumer key to the Platform catalog", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await listToolkits({ composio: { key: "ck_test" } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.source).toBe("curated");
  });
});

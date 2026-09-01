import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionStatus } from "./composio.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Composio account status", () => {
  it("keeps every active account for explicit multi-account selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({
                  data: {
                    results: {
                      gmail: {
                        accounts: [
                          { id: "acct-work", alias: "Work", status: "ACTIVE" },
                          { account_id: "acct-personal", status: "ACTIVE" },
                        ],
                      },
                    },
                  },
                }),
              }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(connectionStatus({ composio: { key: "ck_test" } }, ["gmail"])).resolves.toEqual({
      gmail: {
        connected: true,
        status: "unknown",
        accounts: [
          { id: "acct-work", alias: "Work", status: "ACTIVE" },
          { id: "acct-personal", status: "ACTIVE" },
        ],
      },
    });
  });
});

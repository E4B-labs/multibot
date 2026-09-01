import { describe, expect, it } from "vitest";

import {
  canonicalWebTool,
  executeWebTool,
  webToolDefinitionsForProvider,
  type WebFetchResponse,
} from "./web-tools.ts";

const response = (body: string, status = 200, contentType = "text/html"): WebFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
  text: async () => body,
});

describe("web tool registry", () => {
  it("canonicalizes the public names and legacy fetch aliases", () => {
    expect(canonicalWebTool("web_search")).toBe("web_search");
    expect(canonicalWebTool("websearch")).toBe("web_search");
    expect(canonicalWebTool("web-extract")).toBe("web_extract");
    expect(canonicalWebTool("fetch")).toBe("web_extract");
    expect(canonicalWebTool("WebFetch")).toBe("web_extract");
    expect(canonicalWebTool("not_a_tool")).toBeNull();
  });

  it("publishes exactly the canonical function definitions", () => {
    expect(webToolDefinitionsForProvider().map((tool) => tool.function.name)).toEqual([
      "web_search",
      "web_extract",
    ]);
  });

  it("executes search and fetch aliases with mocked HTTP only", async () => {
    const calls: string[] = [];
    const fetcher = async (input: string | URL): Promise<WebFetchResponse> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("duckduckgo")) {
        return response('<a class="result__a" href="https://example.test/a">Example result</a>');
      }
      return response("<html><script>ignored()</script><main>Hello <b>world</b></main></html>");
    };

    await expect(executeWebTool("websearch", { query: "multi bot" }, fetcher)).resolves.toContain("Example result");
    await expect(executeWebTool("fetch", { url: "https://example.test/page" }, fetcher)).resolves.toBe("Hello world");
    expect(calls).toEqual([
      "https://html.duckduckgo.com/html/?q=multi+bot",
      "https://example.test/page",
    ]);
  });

  it("rejects invalid URLs and non-HTTP schemes before the dependency is called", async () => {
    let called = false;
    const fetcher = async (): Promise<WebFetchResponse> => {
      called = true;
      return response("unused");
    };
    await expect(executeWebTool("web_extract", { url: "file:///secret" }, fetcher)).rejects.toThrow(/HTTP or HTTPS/);
    expect(called).toBe(false);
  });
});

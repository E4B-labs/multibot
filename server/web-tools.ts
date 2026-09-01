// Provider-neutral web tools. Native providers and the Hermes engine expose
// different spellings for the same operations, so the harness owns one small
// registry and one execution path for aliases and tests.

export const WEB_TOOL_NAMES = ["web_search", "web_extract"] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

const WEB_ALIASES: Record<string, WebToolName> = {
  fetch: "web_extract",
  web_fetch: "web_extract",
  webfetch: "web_extract",
  web_extract: "web_extract",
  web_extract_url: "web_extract",
  web_search: "web_search",
  websearch: "web_search",
};

export interface WebToolDefinition {
  name: WebToolName;
  description: string;
  parameters: Record<string, unknown>;
  aliases: readonly string[];
}

export const WEB_TOOL_DEFINITIONS: readonly WebToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the public web for current information.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    },
    aliases: ["websearch"],
  },
  {
    name: "web_extract",
    description: "Fetch a public HTTP(S) URL and return readable page text.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "HTTP(S) URL" } },
      required: ["url"],
      additionalProperties: false,
    },
    aliases: ["fetch", "webfetch", "web_fetch"],
  },
] as const;

export function canonicalWebTool(name: unknown): WebToolName | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/[.\-/\s]+/g, "_");
  return WEB_ALIASES[key] ?? null;
}

export function webToolDefinition(name: unknown): WebToolDefinition | null {
  const canonical = canonicalWebTool(name);
  return canonical ? WEB_TOOL_DEFINITIONS.find((tool) => tool.name === canonical) ?? null : null;
}

export function webToolDefinitionsForProvider(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return WEB_TOOL_DEFINITIONS.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export interface WebFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type WebFetcher = (input: string | URL, init?: RequestInit) => Promise<WebFetchResponse>;

const MAX_QUERY = 500;
const MAX_URL = 2_048;
const MAX_BODY = 1_000_000;

function cleanText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY);
}

function publicUrl(value: unknown): URL {
  if (typeof value !== "string" || value.trim().length > MAX_URL) throw new Error("url must be a valid HTTP(S) URL");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("url must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must use HTTP or HTTPS");
  return url;
}

function query(value: unknown): string {
  const out = typeof value === "string" ? value.trim() : "";
  if (!out || out.length > MAX_QUERY) throw new Error("query is required (max 500 characters)");
  return out;
}

function responseBodyLimit(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n[content truncated]` : text;
}

export async function webExtract(url: unknown, fetcher: WebFetcher = fetch as unknown as WebFetcher): Promise<string> {
  const target = publicUrl(url);
  const response = await fetcher(target, {
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`web_extract HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("html") ? cleanText(responseBodyLimit(body)) : responseBodyLimit(body).trim();
}

function searchResults(html: string): string {
  const results: string[] = [];
  const itemPattern = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(html)) && results.length < 8) {
    const title = cleanText(match[2]);
    let href = match[1];
    try {
      href = new URL(href, "https://html.duckduckgo.com").toString();
    } catch {
      continue;
    }
    if (title) results.push(`${title}\n${href}`);
  }
  return results.length ? results.join("\n\n") : cleanText(html).slice(0, MAX_BODY);
}

export async function webSearch(queryValue: unknown, fetcher: WebFetcher = fetch as unknown as WebFetcher): Promise<string> {
  const target = new URL("https://html.duckduckgo.com/html/");
  target.searchParams.set("q", query(queryValue));
  const response = await fetcher(target, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`web_search HTTP ${response.status}`);
  return searchResults(responseBodyLimit(body));
}

export async function executeWebTool(
  name: unknown,
  args: Record<string, unknown> = {},
  fetcher: WebFetcher = fetch as unknown as WebFetcher,
): Promise<string> {
  const canonical = canonicalWebTool(name);
  if (!canonical) throw new Error(`unknown web tool: ${String(name)}`);
  return canonical === "web_search" ? webSearch(args.query, fetcher) : webExtract(args.url, fetcher);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "../../config.ts";

export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_CATALOG_REFRESH_MS = 12 * 60 * 60 * 1000;

const CACHE_PATH = join(DATA_DIR, "opencode-models.json");
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;

export interface OpenCodeModelOption {
  id: string;
  label: string;
}

export interface OpenCodeModels {
  default: string;
  options: OpenCodeModelOption[];
  updatedAt?: string;
}

interface OpenCodeModelRow {
  id: string;
  name?: unknown;
  pricing?: unknown;
}

interface OpenCodeCatalogCache {
  fetchedAt: number;
  updatedAt: string;
  go: OpenCodeModels;
  zen: OpenCodeModels;
}

const FALLBACK_GO = [
  // Preference order for the default (see modelsFor) — Astra goes after Luna.
  "gpt-5.6-luna",
  "gpt-6-astra",
  "grok-4.6",
  "kimi-k2.5",
];
const FALLBACK_ZEN = [
  "big-pickle",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
];

const asRows = (body: unknown): OpenCodeModelRow[] => {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) return [];
  return (body as { data: unknown[] }).data.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const id = typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id.trim() : "";
    return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id)
      ? [{ id, name: (row as OpenCodeModelRow).name, pricing: (row as OpenCodeModelRow).pricing }]
      : [];
  });
};

const isZeroPriced = (pricing: unknown): boolean => {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return false;
  const values = Object.values(pricing as Record<string, unknown>)
    .map((value) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN)
    .filter((value) => Number.isFinite(value));
  return values.length > 0 && values.every((value) => value === 0);
};

export const isFreeZenModel = (row: OpenCodeModelRow): boolean =>
  row.id === "big-pickle" || row.id.endsWith("-free") || isZeroPriced(row.pricing);

const optionList = (rows: OpenCodeModelRow[], prefix: "opencode-go" | "opencode"): OpenCodeModelOption[] => {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const id = `${prefix}/${row.id}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.id;
    return [{ id, label }];
  });
};

// Default: the first preferred id the catalog actually serves, then the first
// option it does serve. Both come from `optionList`, so the id always carries
// this group's prefix — a Zen id can never end up as the Go default.
const modelsFor = (
  rows: OpenCodeModelRow[],
  prefix: "opencode-go" | "opencode",
  preferred: readonly string[],
  updatedAt?: string,
): OpenCodeModels => {
  const options = optionList(rows, prefix);
  const preferredIds = preferred.map((id) => `${prefix}/${id}`);
  return {
    default: preferredIds.find((id) => options.some((option) => option.id === id))
      ?? options[0]?.id
      ?? preferredIds[0],
    options,
    ...(updatedAt ? { updatedAt } : {}),
  };
};

export function parseOpenCodeCatalog(goBody: unknown, zenBody: unknown, updatedAt = new Date().toISOString()) {
  const goRows = asRows(goBody);
  const zenRows = asRows(zenBody).filter(isFreeZenModel);
  const go = modelsFor(goRows, "opencode-go", FALLBACK_GO, updatedAt);
  const zen = modelsFor(zenRows, "opencode", FALLBACK_ZEN, updatedAt);
  if (!go.options.length) go.options = FALLBACK_GO.map((id) => ({ id: `opencode-go/${id}`, label: id }));
  if (!zen.options.length) zen.options = FALLBACK_ZEN.map((id) => ({ id: `opencode/${id}`, label: id }));
  return { go, zen, updatedAt } satisfies Pick<OpenCodeCatalogCache, "go" | "zen" | "updatedAt">;
}

const validModels = (value: unknown, prefix: "opencode-go" | "opencode"): value is OpenCodeModels => {
  if (!value || typeof value !== "object") return false;
  const models = value as Partial<OpenCodeModels>;
  return typeof models.default === "string" && models.default.startsWith(`${prefix}/`)
    && Array.isArray(models.options) && models.options.length > 0
    && models.options.every((option) => option && typeof option.id === "string" && option.id.startsWith(`${prefix}/`)
      && typeof option.label === "string")
    && (models.updatedAt === undefined || typeof models.updatedAt === "string");
};

const validCache = (value: unknown): value is OpenCodeCatalogCache => {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<OpenCodeCatalogCache>;
  return typeof cache.fetchedAt === "number" && Number.isFinite(cache.fetchedAt)
    && typeof cache.updatedAt === "string"
    && validModels(cache.go, "opencode-go") && validModels(cache.zen, "opencode");
};

export class OpenCodeCatalogStore {
  readonly go: OpenCodeModels;
  readonly zen: OpenCodeModels;
  lastRefreshSucceeded = false;
  private fetchedAt = 0;
  private retryAt = 0;
  private pending: Promise<OpenCodeCatalogCache> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly cachePath: string;

  constructor(fetcher: typeof fetch = fetch, cachePath = CACHE_PATH) {
    this.fetcher = fetcher;
    this.cachePath = cachePath;
    const cached = this.readCache();
    this.fetchedAt = cached?.fetchedAt ?? 0;
    this.lastRefreshSucceeded = Boolean(cached);
    this.go = cached?.go ?? modelsFor([], "opencode-go", FALLBACK_GO);
    this.zen = cached?.zen ?? modelsFor([], "opencode", FALLBACK_ZEN);
    if (!this.go.options.length) this.go.options = FALLBACK_GO.map((id) => ({ id: `opencode-go/${id}`, label: id }));
    if (!this.zen.options.length) this.zen.options = FALLBACK_ZEN.map((id) => ({ id: `opencode/${id}`, label: id }));
  }

  private readCache(): OpenCodeCatalogCache | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const value: unknown = JSON.parse(readFileSync(this.cachePath, "utf8"));
      return validCache(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`OpenCode model catalog returned HTTP ${response.status}`);
    return response.json();
  }

  async refresh(force = false): Promise<OpenCodeCatalogCache> {
    const now = Date.now();
    if (!force && now - this.fetchedAt < OPENCODE_CATALOG_REFRESH_MS) return {
      fetchedAt: this.fetchedAt,
      updatedAt: this.go.updatedAt ?? this.zen.updatedAt ?? "",
      go: this.go,
      zen: this.zen,
    };
    if (!force && now < this.retryAt) return {
      fetchedAt: this.fetchedAt,
      updatedAt: this.go.updatedAt ?? this.zen.updatedAt ?? "",
      go: this.go,
      zen: this.zen,
    };
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const [goBody, zenBody] = await Promise.all([
          this.fetchJson(OPENCODE_GO_MODELS_URL),
          this.fetchJson(OPENCODE_ZEN_MODELS_URL),
        ]);
        if (!asRows(goBody).length || !asRows(zenBody).some(isFreeZenModel)) throw new Error("OpenCode catalog is empty");
        const updatedAt = new Date().toISOString();
        const parsed = parseOpenCodeCatalog(goBody, zenBody, updatedAt);
        const next: OpenCodeCatalogCache = { fetchedAt: Date.now(), ...parsed };
        this.go.default = next.go.default;
        this.go.options = next.go.options;
        this.go.updatedAt = next.go.updatedAt;
        this.zen.default = next.zen.default;
        this.zen.options = next.zen.options;
        this.zen.updatedAt = next.zen.updatedAt;
        this.fetchedAt = next.fetchedAt;
        this.lastRefreshSucceeded = true;
        this.retryAt = 0;
        mkdirSync(dirname(this.cachePath), { recursive: true });
        writeFileSync(this.cachePath, JSON.stringify(next, null, 2), { mode: 0o600 });
        return next;
      } catch {
        this.lastRefreshSucceeded = false;
        this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        return {
          fetchedAt: this.fetchedAt,
          updatedAt: this.go.updatedAt ?? this.zen.updatedAt ?? "",
          go: this.go,
          zen: this.zen,
        };
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), OPENCODE_CATALOG_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const openCodeCatalog = new OpenCodeCatalogStore();
export const refreshOpenCodeModels = () => openCodeCatalog.refresh();
export const startOpenCodeModelRefresh = () => openCodeCatalog.start();

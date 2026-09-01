import { describe, expect, expectTypeOf, it } from "vitest";

import {
  normalizeHostUrl,
  removeHost,
  renameHost,
  resolveLastUsedHost,
  upsertHost,
} from "@multibot/webui-core";
import type { AuthMode, HostRecord, PlatformAdapter, StoredAuth } from "@multibot/webui-core";

const firstHost: HostRecord = {
  id: "first",
  name: "First host",
  url: "https://first.example",
  createdAt: 1,
};

const secondHost: HostRecord = {
  id: "second",
  name: "Second host",
  url: "https://second.example",
  createdAt: 2,
  lastUsedAt: 20,
};

describe("normalizeHostUrl", () => {
  it("adds HTTPS to a bare host and removes trailing slashes", () => {
    expect(normalizeHostUrl(" example.com/// ")).toBe("https://example.com");
    expect(normalizeHostUrl("http://localhost:8799///")).toBe("http://localhost:8799");
    expect(normalizeHostUrl("https://example.com/path///")).toBe("https://example.com/path");
  });

  it("rejects unsupported, malformed, and credential-bearing URLs", () => {
    expect(() => normalizeHostUrl("ftp://example.com")).toThrow();
    expect(() => normalizeHostUrl("not a host")).toThrow();
    expect(() => normalizeHostUrl("not-a-url")).toThrow();
    expect(() => normalizeHostUrl("https://user:password@example.com")).toThrow();
    expect(() => normalizeHostUrl("https://user@example.com")).toThrow();
  });
});

describe("shared contracts", () => {
  it("exports auth and platform adapter shapes without runtime dependencies", () => {
    expectTypeOf<AuthMode>().toEqualTypeOf<"v2" | "legacy">();
    expectTypeOf<StoredAuth>().toMatchTypeOf<{
      token: string;
      mode: AuthMode;
      userId?: string;
    }>();
    expectTypeOf<PlatformAdapter>().toMatchTypeOf<{
      kind: "desktop" | "mobile" | "browser";
      loadAuth: () => Promise<StoredAuth | null>;
      saveAuth: (auth: StoredAuth) => Promise<void>;
      clearAuth: () => Promise<void>;
      openHostManager: () => Promise<void>;
      switchHost: (hostId: string) => Promise<void>;
      requestMicrophonePermission?: () => Promise<boolean>;
    }>();
  });
});

describe("host list helpers", () => {
  it("upserts a host by id without mutating the input list", () => {
    const replacement = { ...firstHost, name: "Renamed first" };

    expect(upsertHost([firstHost, secondHost], replacement)).toEqual([replacement, secondHost]);
    expect([firstHost, secondHost]).toEqual([firstHost, secondHost]);
  });

  it("renames only the matching host without mutating the input list", () => {
    const hosts = [firstHost, secondHost];

    expect(renameHost(hosts, "second", "Production")).toEqual([
      firstHost,
      { ...secondHost, name: "Production" },
    ]);
    expect(hosts).toEqual([firstHost, secondHost]);
  });

  it("removes only the matching host without mutating the input list", () => {
    const hosts = [firstHost, secondHost];

    expect(removeHost(hosts, "first")).toEqual([secondHost]);
    expect(hosts).toEqual([firstHost, secondHost]);
  });

  it("resolves the host with the newest last-used timestamp", () => {
    const latest = { ...firstHost, lastUsedAt: 30 };

    expect(resolveLastUsedHost([secondHost, latest])).toEqual(latest);
    expect(resolveLastUsedHost([firstHost])).toBeUndefined();
    expect(resolveLastUsedHost([])).toBeUndefined();
  });
});

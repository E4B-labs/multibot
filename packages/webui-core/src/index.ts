export type AuthMode = "v2" | "legacy";

export interface StoredAuth {
  token: string;
  mode: AuthMode;
  userId?: string;
}

export interface HostRecord {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface PlatformAdapter {
  kind: "desktop" | "mobile" | "browser";
  loadAuth(): Promise<StoredAuth | null>;
  saveAuth(auth: StoredAuth): Promise<void>;
  clearAuth(): Promise<void>;
  openHostManager(): Promise<void>;
  switchHost(hostId: string): Promise<void>;
  requestMicrophonePermission?(): Promise<boolean>;
}

export function normalizeHostUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Host URL is required");

  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  if (explicitScheme && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Host URL must use http or https");
  }
  const hasScheme = /^https?:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Host URL must use http or https");
  }
  if (!hasScheme && parsed.hostname !== "localhost" && !parsed.hostname.includes(".") && !/^[\da-f:]+$/i.test(parsed.hostname)) {
    throw new Error("Host URL is invalid");
  }

  const authorityStart = candidate.indexOf("://") + 3;
  const authorityEnd = candidate.slice(authorityStart).search(/[/?#]/);
  const authority = candidate.slice(
    authorityStart,
    authorityEnd === -1 ? candidate.length : authorityStart + authorityEnd,
  );
  if (authority.includes("@") || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error("Host URL must not contain credentials");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}${parsed.search}${parsed.hash}`;
}

export function upsertHost(hosts: readonly HostRecord[], host: HostRecord): HostRecord[] {
  return [host, ...hosts.filter((existing) => existing.id !== host.id)];
}

export function renameHost(hosts: readonly HostRecord[], id: string, name: string): HostRecord[] {
  return hosts.map((host) => (host.id === id ? { ...host, name } : host));
}

export function removeHost(hosts: readonly HostRecord[], id: string): HostRecord[] {
  return hosts.filter((host) => host.id !== id);
}

export function resolveLastUsedHost(hosts: readonly HostRecord[]): HostRecord | undefined {
  let latest: HostRecord | undefined;
  for (const host of hosts) {
    if (host.lastUsedAt === undefined) continue;
    if (latest === undefined || latest.lastUsedAt === undefined || host.lastUsedAt > latest.lastUsedAt) {
      latest = host;
    }
  }
  return latest;
}

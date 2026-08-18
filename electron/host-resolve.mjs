// Pure host-resolution logic for the Electron shell (C2). Deliberately free
// of Electron/fs/safeStorage imports so it runs under plain `node` in the
// self-check (host-resolve.test.mjs) without a packaged app context.

/** @typedef {{ id: string, name: string, url: string, tokenEnc: string, createdAt: number }} RemoteHost */
/** @typedef {{ activeId: string, hosts: RemoteHost[] }} HostsConfig */

/** Strips trailing slashes and rejects anything that isn't http(s). */
export function normalizeRemoteUrl(raw) {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error("Host address must start with http:// or https://");
  }
  return trimmed;
}

/** Adds or replaces a host by id, newest first. */
export function upsertRemoteHost(hosts, host) {
  return [host, ...hosts.filter((h) => h.id !== host.id)];
}

export function removeRemoteHost(hosts, id) {
  return hosts.filter((h) => h.id !== id);
}

/** Given the persisted config, decides what main.mjs should load: "local"
 * (today's default, unchanged) or a specific remote host record. Any
 * dangling activeId (host removed, corrupt config) falls back to local
 * rather than erroring — never brick the app on a bad hosts.json. */
export function resolveActiveTarget(config) {
  if (!config || !config.activeId || config.activeId === "local") return { mode: "local" };
  const host = (config.hosts ?? []).find((h) => h.id === config.activeId);
  if (!host) return { mode: "local" };
  return { mode: "remote", host };
}

// multibot (A1): Firebase Google login — server side. Three independent
// pieces, all inert until `firebase.projectId` is set in config:
//   1. verifyFirebaseIdToken — RS256 JWT check against Google's public certs,
//      pure node:crypto, no firebase-admin/jose/jsonwebtoken.
//   2. device sessions — opaque cookie value, only its sha256 hash persists.
//   3. authorizeOwner — first Firebase UID binds as owner; only from
//      loopback or with the existing global access token already presented.
// server/index.ts owns the actual routes/mounting; this file only exports
// the building blocks (see PLAN-COMPUTER.md "Faza A1").
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { loadConfig, saveConfig, type AppConfig } from "./config.ts";

export class FirebaseAuthError extends Error {}

// ── 1. ID token verification ───────────────────────────────────────────

const GOOGLE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_MS = 60_000;
const DEFAULT_CERT_MAX_AGE_MS = 3_600_000;

export interface FirebaseIdTokenClaims {
  uid: string;
  email?: string;
}

/** kid -> PEM (X.509 cert or bare public key both work with createPublicKey)
 * plus how long the caller may trust it. Injectable so tests never hit the
 * network. */
export type CertFetcher = () => Promise<{ certs: Record<string, string>; maxAgeMs: number }>;

export const defaultCertFetcher: CertFetcher = async () => {
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new FirebaseAuthError("failed to fetch Google signing certs");
  const certs = (await res.json()) as Record<string, string>;
  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  const maxAgeMs = m ? Number(m[1]) * 1000 : DEFAULT_CERT_MAX_AGE_MS;
  return { certs, maxAgeMs };
};

// ponytail: module-level singleton cache, keyed by fetcher identity so
// swapping in a test fetcher never serves another test's certs. One process,
// one cert set at a time — fine for a self-hosted harness.
let certCache: { certs: Record<string, string>; expiresAt: number; fetcher: CertFetcher } | null = null;

async function getCerts(fetcher: CertFetcher, now: number): Promise<Record<string, string>> {
  if (certCache && certCache.fetcher === fetcher && certCache.expiresAt > now) return certCache.certs;
  const { certs, maxAgeMs } = await fetcher();
  certCache = { certs, expiresAt: now + Math.max(maxAgeMs, 0), fetcher };
  return certs;
}

function decodePart(part: string): any {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new FirebaseAuthError("malformed token");
  }
}

/** Verifies a Firebase Authentication ID token per
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library.
 * Throws FirebaseAuthError with a short, non-leaky reason on any failure. */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
  opts: { certFetcher?: CertFetcher; now?: number } = {},
): Promise<FirebaseIdTokenClaims> {
  if (typeof idToken !== "string" || !idToken) throw new FirebaseAuthError("missing token");
  if (typeof projectId !== "string" || !projectId) throw new FirebaseAuthError("firebase not configured");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new FirebaseAuthError("malformed token");
  const [headerPart, payloadPart, sigPart] = parts;

  const header = decodePart(headerPart);
  if (header.alg !== "RS256") throw new FirebaseAuthError("unsupported algorithm");
  if (typeof header.kid !== "string" || !header.kid) throw new FirebaseAuthError("missing key id");

  let signature: Buffer;
  try {
    signature = Buffer.from(sigPart, "base64url");
  } catch {
    throw new FirebaseAuthError("malformed token");
  }
  if (!signature.length) throw new FirebaseAuthError("malformed token");

  const now = opts.now ?? Date.now();
  const certs = await getCerts(opts.certFetcher ?? defaultCertFetcher, now);
  const cert = certs[header.kid];
  if (!cert) throw new FirebaseAuthError("unknown signing key");

  let publicKey;
  try {
    publicKey = createPublicKey(cert);
  } catch {
    throw new FirebaseAuthError("invalid signing cert");
  }
  let signatureOk = false;
  try {
    signatureOk = cryptoVerify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`, "utf8"), publicKey, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new FirebaseAuthError("invalid signature");

  // Signature confirmed — payload can now be trusted for claim checks.
  const payload = decodePart(payloadPart);
  if (typeof payload.aud !== "string" || payload.aud !== projectId) {
    throw new FirebaseAuthError("wrong audience");
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new FirebaseAuthError("wrong issuer");
  }
  if (typeof payload.exp !== "number" || now > payload.exp * 1000 + CLOCK_SKEW_MS) {
    throw new FirebaseAuthError("expired token");
  }
  if (typeof payload.iat !== "number" || payload.iat * 1000 > now + CLOCK_SKEW_MS) {
    throw new FirebaseAuthError("token not yet valid");
  }
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) throw new FirebaseAuthError("missing subject");

  return { uid: sub, email: typeof payload.email === "string" ? payload.email : undefined };
}

// ── 2. Device sessions ──────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = "mb_session";

export interface DeviceSession {
  /** sha256(session id) hex — safe to list/revoke by; the raw session id
   * (the actual cookie value) is never stored or returned again. */
  id: string;
  uid: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
}

function hashSessionId(sessionId: string): Buffer {
  return createHash("sha256").update(sessionId, "utf8").digest();
}

/** Creates a session for `uid` and returns the raw (opaque) session id to
 * set as the cookie value. Only its hash is persisted. */
export function createDeviceSession(uid: string, label: string): string {
  const raw = randomBytes(32).toString("hex");
  const id = hashSessionId(raw).toString("hex");
  const now = Date.now();
  const record: DeviceSession = { id, uid, label, createdAt: now, lastSeenAt: now };
  saveConfig({ deviceSessions: { [id]: record } });
  return raw;
}

/** Looks up a session by its raw (cookie) value. Constant-time compare
 * against every stored hash, same house style as `auth.ts` `tokenMatches` —
 * see that file's comment for why. Bumps `lastSeenAt` on success. */
export function verifyDeviceSession(sessionId: string): DeviceSession | null {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const candidate = hashSessionId(sessionId);
  const sessions = loadConfig().deviceSessions ?? {};
  for (const [id, record] of Object.entries(sessions)) {
    const stored = Buffer.from(id, "hex");
    if (stored.length !== candidate.length || !timingSafeEqual(candidate, stored)) continue;
    const updated: DeviceSession = { ...record, lastSeenAt: Date.now() };
    saveConfig({ deviceSessions: { [id]: updated } });
    return updated;
  }
  return null;
}

export function listDeviceSessions(): DeviceSession[] {
  return Object.values(loadConfig().deviceSessions ?? {});
}

/** Revokes by the session's `id` (the hash, from verify/list — never the raw
 * cookie value). Any HTTP/SSE/WS call authenticated by this session must
 * fail afterward, since verifyDeviceSession can no longer find it. */
export function revokeDeviceSession(id: string): boolean {
  const sessions = loadConfig().deviceSessions ?? {};
  if (!sessions[id]) return false;
  // `saveConfig` merges by top-level key; deletion goes through `undefined`
  // (see server/mcp-connectors.ts removeConnector for the same trick).
  saveConfig({ deviceSessions: { [id]: undefined } } as unknown as Partial<AppConfig>);
  return true;
}

// ── Cookie helpers ───────────────────────────────────────────────────────

/** A self-hosted install often runs on plain-http loopback (no TLS
 * terminator in front). Unconditionally setting `Secure` would make the
 * browser silently drop the cookie there and break loopback login — so
 * `Secure` is only added when the request actually arrived over TLS. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const socket = req.socket as unknown as { encrypted?: boolean };
  if (socket?.encrypted) return true;
  return String(req.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https";
}

export function buildSessionCookie(sessionId: string, secure: boolean): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict"];
  if (secure) attrs.push("Secure");
  return `${SESSION_COOKIE_NAME}=${sessionId}; ${attrs.join("; ")}`;
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return `${SESSION_COOKIE_NAME}=; ${attrs.join("; ")}`;
}

export function sessionIdFromCookieHeader(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

// ── 3. First-owner binding ───────────────────────────────────────────────

export function isFirebaseConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.firebase?.projectId?.trim());
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** First Firebase UID to call this becomes the owner (persisted in
 * `firebase.ownerUid`); every later call must present that same UID.
 * Binding a *new* owner (the config has none yet) additionally requires
 * `loopback` or `bearerAuthed` — never "first caller from the internet
 * wins". Throws FirebaseAuthError when refused. */
export function authorizeOwner(uid: string, ctx: { loopback: boolean; bearerAuthed: boolean }): void {
  const cfg = loadConfig();
  const existing = cfg.firebase?.ownerUid;
  if (existing) {
    if (existing !== uid) throw new FirebaseAuthError("owner mismatch");
    return;
  }
  if (!ctx.loopback && !ctx.bearerAuthed) {
    throw new FirebaseAuthError("owner binding requires loopback or the existing access token");
  }
  saveConfig({ firebase: { ownerUid: uid } });
}

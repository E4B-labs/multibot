import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { rmSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeOwner,
  createDeviceSession,
  FirebaseAuthError,
  isSecureRequest,
  revokeDeviceSession,
  sessionIdFromCookieHeader,
  verifyDeviceSession,
  verifyFirebaseIdToken,
  type CertFetcher,
} from "./firebase-auth.ts";
import { DATA_DIR } from "./config.ts";

const PROJECT_ID = "multibot-test";
const ISS = `https://securetoken.google.com/${PROJECT_ID}`;
const KID = "test-kid-1";

let privateKey: KeyObject;
let certFetcher: CertFetcher;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(payload: Record<string, unknown>, opts: { alg?: string; kid?: string } = {}): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: PROJECT_ID,
    iss: ISS,
    sub: "uid-abc123",
    email: "user@example.com",
    iat: now - 10,
    exp: now + 3600,
    ...overrides,
  };
}

beforeAll(() => {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = priv;
  const certPem = pub.export({ type: "spki", format: "pem" }) as string;
  certFetcher = vi.fn(async () => ({ certs: { [KID]: certPem }, maxAgeMs: 10 * 60_000 }));
});

describe("verifyFirebaseIdToken", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("verifies a correctly signed token and caches certs across calls", async () => {
    const token = signToken(validClaims());
    const claims = await verifyFirebaseIdToken(token, PROJECT_ID, { certFetcher });
    expect(claims).toEqual({ uid: "uid-abc123", email: "user@example.com" });

    await verifyFirebaseIdToken(signToken(validClaims()), PROJECT_ID, { certFetcher });
    expect(certFetcher).toHaveBeenCalledTimes(1); // cached, not refetched per call
  });

  it("rejects wrong audience", async () => {
    const token = signToken(validClaims({ aud: "someone-else" }));
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, { certFetcher })).rejects.toThrow(FirebaseAuthError);
  });

  it("rejects wrong issuer", async () => {
    const token = signToken(validClaims({ iss: "https://securetoken.google.com/other-project" }));
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, { certFetcher })).rejects.toThrow(FirebaseAuthError);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(validClaims({ iat: now - 7200, exp: now - 3600 }));
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, { certFetcher })).rejects.toThrow(FirebaseAuthError);
  });

  it("rejects a tampered signature", async () => {
    const token = signToken(validClaims());
    const [h, p, s] = token.split(".");
    const flipped = s[0] === "A" ? "B" : "A";
    const tampered = `${h}.${p}.${flipped}${s.slice(1)}`;
    await expect(verifyFirebaseIdToken(tampered, PROJECT_ID, { certFetcher })).rejects.toThrow(FirebaseAuthError);
  });

  it("rejects alg: none outright, without ever touching the cert source", async () => {
    const header = { alg: "none", typ: "JWT", kid: KID };
    const payload = validClaims();
    const token = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.`;
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, { certFetcher })).rejects.toThrow(FirebaseAuthError);
    expect(certFetcher).not.toHaveBeenCalled();
  });
});

describe("device sessions", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("create -> verify -> revoke -> verify fails", () => {
    const raw = createDeviceSession("uid-1", "my-laptop");
    const found = verifyDeviceSession(raw);
    expect(found).toMatchObject({ uid: "uid-1", label: "my-laptop" });

    expect(revokeDeviceSession(found!.id)).toBe(true);
    expect(verifyDeviceSession(raw)).toBeNull();
  });

  it("parses the session id back out of a Cookie header", () => {
    expect(sessionIdFromCookieHeader("foo=bar; mb_session=abc123; other=x")).toBe("abc123");
    expect(sessionIdFromCookieHeader("foo=bar")).toBeNull();
    expect(sessionIdFromCookieHeader(undefined)).toBeNull();
  });

  it("only sets Secure when isSecureRequest says the request was TLS", () => {
    const plain = { socket: {}, headers: {} } as any;
    const tls = { socket: { encrypted: true }, headers: {} } as any;
    const proxied = { socket: {}, headers: { "x-forwarded-proto": "https" } } as any;
    expect(isSecureRequest(plain)).toBe(false);
    expect(isSecureRequest(tls)).toBe(true);
    expect(isSecureRequest(proxied)).toBe(true);
  });
});

describe("authorizeOwner", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("refuses to bind the first owner from a non-loopback request without the access token", () => {
    expect(() => authorizeOwner("uid-1", { loopback: false, bearerAuthed: false })).toThrow(FirebaseAuthError);
  });

  it("binds from loopback, then rejects a different uid, but keeps allowing the bound uid from anywhere", () => {
    authorizeOwner("uid-1", { loopback: true, bearerAuthed: false });
    expect(() => authorizeOwner("uid-2", { loopback: true, bearerAuthed: false })).toThrow(FirebaseAuthError);
    expect(() => authorizeOwner("uid-1", { loopback: false, bearerAuthed: false })).not.toThrow();
  });

  it("also allows first-owner binding when the request carries the existing access token", () => {
    expect(() => authorizeOwner("uid-1", { loopback: false, bearerAuthed: true })).not.toThrow();
  });
});

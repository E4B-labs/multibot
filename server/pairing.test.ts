// multibot (C1): a six-digit code is only safe while expiry, single-use and the
// guess cap all hold. Each of those is a test here.
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, PAIRING_TTL_MS, cancelPairing, claimPairing, pairingPending, startPairing } from "./pairing.ts";

beforeEach(() => cancelPairing());

describe("pairing", () => {
  it("issues a six-digit code and redeems it once", () => {
    const now = 1_000_000;
    const { code } = startPairing(now);
    expect(code).toMatch(/^\d{6}$/);
    expect(claimPairing(code, now)).toEqual({ ok: true });
    // single use: a shoulder-surfed QR is worthless after the real phone pairs
    expect(claimPairing(code, now)).toEqual({ ok: false, reason: "expired" });
  });

  it("expires", () => {
    const now = 2_000_000;
    const { code } = startPairing(now);
    expect(pairingPending(now + PAIRING_TTL_MS - 1)).toBe(true);
    expect(claimPairing(code, now + PAIRING_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("burns the code once guesses run out, so brute force gets one short window", () => {
    const now = 3_000_000;
    const { code } = startPairing(now);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(claimPairing("000000" === code ? "111111" : "000000", now).ok).toBe(false);
    }
    // even the RIGHT code is dead now
    expect(claimPairing(code, now).ok).toBe(false);
  });

  it("counts malformed input against the cap too", () => {
    const now = 4_000_000;
    const { code } = startPairing(now);
    for (let i = 0; i < MAX_ATTEMPTS; i++) claimPairing("abc", now);
    expect(claimPairing(code, now).ok).toBe(false);
  });

  it("showing a new QR kills the previous one", () => {
    const now = 5_000_000;
    const first = startPairing(now).code;
    startPairing(now);
    expect(claimPairing(first, now).ok).toBe(false);
  });

  it("rejects a claim when nothing is pending", () => {
    expect(claimPairing("123456", 6_000_000)).toEqual({ ok: false, reason: "expired" });
  });
});

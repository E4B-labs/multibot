// multibot (C1): pairing a phone with this host.
//
// The phone scans a QR holding the host URL and a short one-time code, then
// trades the code for a device session. A short numeric code is only safe
// because all three of these hold at once:
//
//   * it expires quickly,
//   * it is single-use,
//   * guesses are capped, and the code dies when the cap is hit.
//
// Drop any one and six digits is guessable. The cap is global per code rather
// than per IP: an attacker picks their own IP, so per-IP counting would just
// hand them unlimited tries.
import { randomInt, timingSafeEqual } from "node:crypto";

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;

interface Pairing {
  code: string;
  expiresAt: number;
  attempts: number;
}

let current: Pairing | null = null;

/** Constant-time compare over equal-length digit strings. */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Start pairing, replacing any code already outstanding — showing a second QR
 * must invalidate the first, or a screenshot of an old one stays live.
 */
export function startPairing(now = Date.now()): { code: string; expiresAt: number } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  current = { code, expiresAt: now + PAIRING_TTL_MS, attempts: 0 };
  return { code, expiresAt: current.expiresAt };
}

export type ClaimResult = { ok: true } | { ok: false; reason: "expired" | "invalid" | "locked" };

/**
 * Redeem a code. Success consumes it, so a QR photographed over someone's
 * shoulder is worthless once the real phone has used it.
 */
export function claimPairing(code: unknown, now = Date.now()): ClaimResult {
  if (!current || current.expiresAt <= now) {
    current = null;
    return { ok: false, reason: "expired" };
  }
  if (current.attempts >= MAX_ATTEMPTS) {
    current = null;
    return { ok: false, reason: "locked" };
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    current.attempts += 1;
    return { ok: false, reason: "invalid" };
  }
  if (!sameCode(code, current.code)) {
    current.attempts += 1;
    // Burning the code on the last wrong guess is the point of the cap.
    if (current.attempts >= MAX_ATTEMPTS) current = null;
    return { ok: false, reason: "invalid" };
  }
  current = null;
  return { ok: true };
}

/** Whether a code is outstanding — for the UI, never exposing the code itself. */
export function pairingPending(now = Date.now()): boolean {
  return Boolean(current && current.expiresAt > now);
}

export function cancelPairing(): void {
  current = null;
}

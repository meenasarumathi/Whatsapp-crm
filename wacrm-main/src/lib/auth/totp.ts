// ============================================================
// TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) with no
// third-party dependency. Server only (node:crypto).
//
// Secrets are base32 so any authenticator app can import them. They are
// stored AES-256-GCM encrypted (see mfa-service) and never logged.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Steps of clock drift accepted either side of "now". */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random 160-bit secret, base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

const stepOf = (at: Date) => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/** The code valid at `at`. */
export function totpAt(secretBase32: string, at: Date): string {
  return hotp(base32Decode(secretBase32), stepOf(at));
}

/** True when `code` matches the current step or one step either side. */
export function verifyTotp(secretBase32: string, code: unknown, now: Date = new Date()): boolean {
  if (typeof code !== "string") return false;
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return false;
  const key = base32Decode(secretBase32);
  const step = stepOf(now);
  let ok = false;
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    // compare every candidate (no early exit) in constant time
    if (timingSafeEqual(Buffer.from(hotp(key, step + d)), Buffer.from(typed))) ok = true;
  }
  return ok;
}

/** otpauth:// URI for authenticator apps (manual entry or a QR code). */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ============================================================
// MFA recovery codes: shown to the user once, stored only as SHA-256.
// Format "xxxxx-xxxxx" from an alphabet without look-alikes (0/o, 1/l).
// ============================================================

import { createHash, randomInt } from "node:crypto";

import { RECOVERY_CODE_COUNT } from "./security-policy";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(randomCode());
  return [...out];
}

/** Lower-case, no spaces or dashes; null when it cannot be a code. */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z0-9]{10}$/.test(s) ? s : null;
}

export function hashRecoveryCode(code: string): string {
  const n = normaliseRecoveryCode(code) ?? code;
  return createHash("sha256").update(`wacrm-recovery:${n}`).digest("hex");
}

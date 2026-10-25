// ============================================================
// Token wallet — units, money and input validation. Pure.
//
// 1 token = 1000 units; one automated message = 500 units (0.5 token).
// Money is integer paise. Nothing here uses floating-point arithmetic
// on stored values; user input is parsed from strings straight into
// integers.
// ============================================================

export const UNITS_PER_TOKEN = 1000;
export const CHARGE_UNITS = 500;

/** Largest single recharge a customer can request: ₹1,00,000. */
export const MAX_RECHARGE_PAISE = 100_000 * 100;
/** Largest single manual adjustment in rupees: ₹10,00,000. */
export const MAX_ADJUST_PAISE = 1_000_000 * 100;
/** Largest single grant / deduction: 1,000,000 tokens. */
export const MAX_ADJUST_UNITS = 1_000_000 * UNITS_PER_TOKEN;
export const MAX_PAYMENT_REFERENCE = 100;
export const MAX_REASON = 500;
export const MAX_RATE_PART = 1_000_000;

/** Folder for payment proofs; private, see proof-store.ts. */
export const PROOF_BUCKET = "recharge-proofs";
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export interface Rate {
  num: number;
  den: number;
}
export const DEFAULT_RATE: Rate = { num: 1, den: 1 };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Rupees as typed ("500", "499.50") → integer paise. Rejects NaN,
 * negatives, zero, more than two decimals, exponents and amounts over
 * the limit.
 */
export function parseRupeesToPaise(input: unknown, max = MAX_RECHARGE_PAISE): Parsed<number> {
  const s = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, error: "Enter an amount in rupees, e.g. 500 or 499.50." };
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (paise <= 0) return { ok: false, error: "Amount must be more than zero." };
  if (paise > max) return { ok: false, error: `Amount can't be more than ₹${(max / 100).toLocaleString("en-IN")}.` };
  return { ok: true, value: paise };
}

/**
 * Tokens as typed ("10", "2.5", "0.5") → integer units. Up to three
 * decimals (1 unit = 0.001 token).
 */
export function parseTokensToUnits(input: unknown, max = MAX_ADJUST_UNITS): Parsed<number> {
  const s = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return { ok: false, error: "Enter a number of tokens, e.g. 100 or 2.5." };
  const units = Number(m[1]) * UNITS_PER_TOKEN + Number((m[2] ?? "").padEnd(3, "0"));
  if (units <= 0) return { ok: false, error: "Amount must be more than zero." };
  if (units > max) return { ok: false, error: "Amount is above the limit." };
  return { ok: true, value: units };
}

/** A whole number in [1, MAX_RATE_PART]. */
export function parseRatePart(input: unknown): Parsed<number> {
  const s = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d{1,7}$/.test(s)) return { ok: false, error: "Use a whole number." };
  const n = Number(s);
  if (n < 1 || n > MAX_RATE_PART) return { ok: false, error: `Use a whole number from 1 to ${MAX_RATE_PART}.` };
  return { ok: true, value: n };
}

/** Must match token_submit_recharge: floor(paise × 10 × num / den). */
export function unitsForPaise(paise: number, rate: Rate): number {
  // BigInt keeps large amounts exact (the TS target predates `10n` literals).
  return Number((BigInt(paise) * BigInt(10) * BigInt(rate.num)) / BigInt(rate.den));
}

/** Units → "12.5" (trailing zeros trimmed). */
export function formatTokens(units: number | bigint | string): string {
  const u = BigInt(units);
  const thousand = BigInt(1000);
  const neg = u < BigInt(0);
  const abs = neg ? -u : u;
  const whole = abs / thousand;
  const frac = (abs % thousand).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-IN")}${frac ? `.${frac}` : ""}`;
}

/** Paise → "₹1,234.50". */
export function formatRupees(paise: number | bigint | string): string {
  const p = BigInt(paise);
  const hundred = BigInt(100);
  const whole = p / hundred;
  const frac = (p % hundred).toString().padStart(2, "0");
  return `₹${whole.toLocaleString("en-IN")}${frac === "00" ? "" : `.${frac}`}`;
}

/**
 * Units → rupee value at a rate, in paise (floor). The inverse of
 * unitsForPaise: paise = units × den / (10 × num). Used to show wallet
 * balances in ₹ like the admin screen.
 */
export function paiseForUnits(units: number, rate: Rate): number {
  return Number((BigInt(Math.trunc(units)) * BigInt(rate.den)) / (BigInt(10) * BigInt(rate.num)));
}

/** Paise → "₹1,234.50" — always two decimals (wallet tables). */
export function formatRupeesExact(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const whole = Math.floor(abs / 100).toLocaleString("en-IN");
  return `${neg ? "-" : ""}₹${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** How many automated messages a balance pays for. */
export function messagesAffordable(units: number): number {
  return Math.floor(Math.max(units, 0) / CHARGE_UNITS);
}

/** Required free-text reason (grant / deduct / reject). */
export function parseReason(input: unknown): Parsed<string> {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) return { ok: false, error: "A reason is required." };
  if (s.length > MAX_REASON) return { ok: false, error: `Keep the reason under ${MAX_REASON} characters.` };
  return { ok: true, value: s };
}

export function parsePaymentReference(input: unknown): Parsed<string | null> {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "Invalid payment reference." };
  const s = input.trim();
  if (s.length > MAX_PAYMENT_REFERENCE) {
    return { ok: false, error: `Payment reference can be at most ${MAX_PAYMENT_REFERENCE} characters.` };
  }
  return { ok: true, value: s || null };
}

/** Validate a proof upload's declared type and size. Returns the extension. */
export function validateProof(file: { type: string; size: number }): Parsed<string> {
  const ext = PROOF_TYPES[file.type];
  if (!ext) return { ok: false, error: "Proof must be a PNG, JPG or PDF file." };
  if (file.size <= 0) return { ok: false, error: "The proof file is empty." };
  if (file.size > PROOF_MAX_BYTES) return { ok: false, error: "Proof file must be 5 MB or smaller." };
  return { ok: true, value: ext };
}

/**
 * Check the file really is what its type claims (magic bytes), so a
 * renamed executable can't be stored as "image/png".
 */
export function sniffProof(bytes: Uint8Array, type: string): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (type === "image/png") return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "image/jpeg") return starts([0xff, 0xd8, 0xff]);
  if (type === "application/pdf") return starts([0x25, 0x50, 0x44, 0x46]); // %PDF
  return false;
}

/** "UPI1234567890" → "UPI1…7890" for logs. */
export function maskReference(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref.length <= 8 ? "…" : `${ref.slice(0, 4)}…${ref.slice(-4)}`;
}

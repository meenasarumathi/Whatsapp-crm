import { describe, expect, it } from "vitest";

import {
  CHARGE_UNITS,
  DEFAULT_RATE,
  MAX_RECHARGE_PAISE,
  PROOF_MAX_BYTES,
  formatRupees,
  formatRupeesExact,
  formatTokens,
  paiseForUnits,
  maskReference,
  messagesAffordable,
  parsePaymentReference,
  parseRatePart,
  parseReason,
  parseRupeesToPaise,
  parseTokensToUnits,
  sniffProof,
  unitsForPaise,
  validateProof,
} from "./units";

describe("1. rate conversion", () => {
  it("₹1 at the default rate is 1000 units (1 token)", () => {
    expect(unitsForPaise(100, DEFAULT_RATE)).toBe(1000);
    expect(unitsForPaise(50_000, DEFAULT_RATE)).toBe(500_000);
  });

  it("uses the rate it is given (a later rate change doesn't alter an earlier figure)", () => {
    const earlier = unitsForPaise(100_00, { num: 1, den: 1 });
    const later = unitsForPaise(100_00, { num: 3, den: 2 });
    expect(earlier).toBe(100_000);
    expect(later).toBe(150_000);
    expect(unitsForPaise(100_00, { num: 1, den: 1 })).toBe(earlier);
  });

  it("floors fractional units and stays exact for large amounts", () => {
    expect(unitsForPaise(1, { num: 1, den: 3 })).toBe(3); // 10/3 → 3
    expect(unitsForPaise(MAX_RECHARGE_PAISE, { num: 1_000_000, den: 1 })).toBe(100_000_000_000_000);
  });

  it("one charge is half a token", () => {
    expect(CHARGE_UNITS).toBe(500);
    expect(formatTokens(CHARGE_UNITS)).toBe("0.5");
    expect(messagesAffordable(1000)).toBe(2);
    expect(messagesAffordable(499)).toBe(0);
  });

  it("formats units and paise without floats", () => {
    expect(formatTokens(1_234_500)).toBe("1,234.5");
    expect(formatTokens(-500)).toBe("-0.5");
    expect(formatRupees(49_950)).toBe("₹499.50");
    expect(formatRupees(50_000)).toBe("₹500");
  });
});

describe("15. input validation", () => {
  it("accepts rupees with up to two decimals", () => {
    expect(parseRupeesToPaise("500")).toEqual({ ok: true, value: 50_000 });
    expect(parseRupeesToPaise("499.5")).toEqual({ ok: true, value: 49_950 });
    expect(parseRupeesToPaise(" 0.01 ")).toEqual({ ok: true, value: 1 });
  });

  it.each(["", "abc", "NaN", "-5", "0", "0.00", "1.234", "1e3", "Infinity", "5,000", " "])(
    "rejects invalid amount %j",
    (v) => {
      expect(parseRupeesToPaise(v).ok).toBe(false);
    },
  );

  it("rejects amounts above the limit and non-string types", () => {
    expect(parseRupeesToPaise(String(MAX_RECHARGE_PAISE / 100 + 1)).ok).toBe(false);
    expect(parseRupeesToPaise(null).ok).toBe(false);
    expect(parseRupeesToPaise({}).ok).toBe(false);
  });

  it("parses token amounts to units", () => {
    expect(parseTokensToUnits("2.5")).toEqual({ ok: true, value: 2500 });
    expect(parseTokensToUnits("0").ok).toBe(false);
    expect(parseTokensToUnits("-1").ok).toBe(false);
    expect(parseTokensToUnits("1.2345").ok).toBe(false);
  });

  it("validates rate parts as whole numbers in range", () => {
    expect(parseRatePart("3")).toEqual({ ok: true, value: 3 });
    for (const bad of ["0", "-1", "1.5", "abc", "10000000"]) expect(parseRatePart(bad).ok).toBe(false);
  });

  it("requires a non-empty reason under the limit", () => {
    expect(parseReason("  ").ok).toBe(false);
    expect(parseReason("x".repeat(501)).ok).toBe(false);
    expect(parseReason(" goodwill ")).toEqual({ ok: true, value: "goodwill" });
  });

  it("limits payment references and masks them for logs", () => {
    expect(parsePaymentReference("x".repeat(101)).ok).toBe(false);
    expect(parsePaymentReference("")).toEqual({ ok: true, value: null });
    expect(maskReference("412345678901")).toBe("4123…8901");
  });

  it("accepts PNG / JPG / PDF proofs up to 5 MB only", () => {
    expect(validateProof({ type: "image/png", size: 1000 })).toEqual({ ok: true, value: "png" });
    expect(validateProof({ type: "application/pdf", size: PROOF_MAX_BYTES })).toEqual({ ok: true, value: "pdf" });
    expect(validateProof({ type: "image/gif", size: 1000 }).ok).toBe(false);
    expect(validateProof({ type: "text/html", size: 1000 }).ok).toBe(false);
    expect(validateProof({ type: "image/jpeg", size: PROOF_MAX_BYTES + 1 }).ok).toBe(false);
    expect(validateProof({ type: "image/jpeg", size: 0 }).ok).toBe(false);
  });

  it("checks the file's real bytes against its claimed type", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const pdf = new TextEncoder().encode("%PDF-1.7");
    expect(sniffProof(png, "image/png")).toBe(true);
    expect(sniffProof(pdf, "application/pdf")).toBe(true);
    expect(sniffProof(new TextEncoder().encode("<html>"), "image/png")).toBe(false);
    expect(sniffProof(png, "image/jpeg")).toBe(false);
  });
});

describe("₹ display of token balances", () => {
  it("converts units back to paise at the rate (inverse of unitsForPaise)", () => {
    expect(paiseForUnits(10_340, DEFAULT_RATE)).toBe(1034); // 10.34 tokens = ₹10.34
    expect(paiseForUnits(1_000_000, { num: 2, den: 1 })).toBe(50_000); // 1000 tokens at ₹1=2 tokens = ₹500
    expect(paiseForUnits(unitsForPaise(12_345, { num: 3, den: 2 }), { num: 3, den: 2 })).toBe(12_345);
  });

  it("formats with two decimals like the wallet table", () => {
    expect(formatRupeesExact(1034)).toBe("₹10.34");
    expect(formatRupeesExact(0)).toBe("₹0.00");
    expect(formatRupeesExact(500_000)).toBe("₹5,000.00");
  });
});

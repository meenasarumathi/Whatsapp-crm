import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpAt,
  verifyTotp,
} from "./totp";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (ASCII).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const at = (unixSeconds: number) => new Date(unixSeconds * 1000);

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (const len of [1, 5, 10, 20, 33]) {
      const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });
  it("ignores spaces, dashes and case when decoding", () => {
    const s = base32Encode(Buffer.from("hello world"));
    expect(base32Decode(s.toLowerCase().replace(/(.{4})/g, "$1 "))).toEqual(Buffer.from("hello world"));
  });
  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC1")).toThrow();
  });
});

describe("TOTP (RFC 6238 vectors, 6 digits)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i → %s", (t, code) => {
    expect(totpAt(RFC_SECRET, at(t))).toBe(code);
  });
});

describe("verifyTotp", () => {
  const now = at(1234567890);
  it("accepts the current code", () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now), now)).toBe(true);
  });
  it("accepts one step of clock drift either way", () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at(1234567890 - 30)), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at(1234567890 + 30)), now)).toBe(true);
  });
  it("rejects codes two steps away", () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at(1234567890 - 60)), now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, at(1234567890 + 60)), now)).toBe(false);
  });
  it("tolerates spaces in the typed code", () => {
    const c = totpAt(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, now)).toBe(true);
  });
  it.each(["", "12345", "1234567", "abcdef", "12345a"])("rejects malformed %j", (bad) => {
    expect(verifyTotp(RFC_SECRET, bad, now)).toBe(false);
  });
});

describe("secrets and otpauth URI", () => {
  it("generates 160-bit secrets that differ", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });
  it("builds an otpauth URI an authenticator app can read", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "ops@example.com", "Zyloop WACRM");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    const u = new URL(uri);
    expect(u.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(u.searchParams.get("issuer")).toBe("Zyloop WACRM");
    expect(u.searchParams.get("digits")).toBe("6");
    expect(decodeURIComponent(u.pathname)).toContain("ops@example.com");
  });
});

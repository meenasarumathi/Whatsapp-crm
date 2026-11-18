import { describe, expect, it } from "vitest";

import { generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode } from "./recovery-codes";
import { RECOVERY_CODE_COUNT } from "./security-policy";

describe("recovery codes", () => {
  it("generates the configured number of distinct codes in xxxxx-xxxxx form", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });

  it("normalises case, spaces and dashes so a typed code matches", () => {
    expect(normaliseRecoveryCode(" AB2CD-EF3GH ")).toBe("ab2cdef3gh");
    expect(normaliseRecoveryCode("ab2cd ef3gh")).toBe("ab2cdef3gh");
  });

  it("rejects input that cannot be a code", () => {
    expect(normaliseRecoveryCode("")).toBeNull();
    expect(normaliseRecoveryCode("short")).toBeNull();
    expect(normaliseRecoveryCode("ab2cd-ef3gh-extra")).toBeNull();
    expect(normaliseRecoveryCode(42)).toBeNull();
  });

  it("stores only a hash, never the code, and the hash is stable", () => {
    const h = hashRecoveryCode("ab2cd-ef3gh");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("ab2cd");
    expect(hashRecoveryCode("AB2CD EF3GH")).toBe(h);
  });
});

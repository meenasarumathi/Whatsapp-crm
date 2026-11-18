import { describe, expect, it } from "vitest";

import { formatIst } from "./ist-time";

describe("formatIst", () => {
  it("shows a UTC instant in India time (UTC+05:30)", () => {
    // 31 Oct 19:00 UTC is 1 Nov 00:30 in India
    expect(formatIst("2026-10-31T19:00:00Z")).toBe("1 Nov 2026, 12:30 am IST");
  });
  it("accepts Date objects", () => {
    expect(formatIst(new Date("2026-11-13T04:30:00Z"))).toBe("13 Nov 2026, 10:00 am IST");
  });
  it("returns an empty string for missing or invalid input", () => {
    expect(formatIst(null)).toBe("");
    expect(formatIst("not a date")).toBe("");
  });
});

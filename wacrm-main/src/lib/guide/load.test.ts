import { describe, expect, it } from "vitest";

import { loadGuide } from "./load";

// Reads the real Guide/ folder: every update is a folder with a README.md.
describe("loadGuide", () => {
  it("lists update folders newest first and skips _TEMPLATE", async () => {
    const { chapters, updates } = await loadGuide();
    expect(chapters.length).toBeGreaterThan(0);
    const slugs = updates.map((u) => u.slug);
    expect(slugs).toContain("2026-10-08-crm-guide");
    expect(slugs.some((s) => s.startsWith("_"))).toBe(false);
    expect([...slugs].sort().reverse()).toEqual(slugs);
    expect(updates.every((u) => u.title && u.date)).toBe(true);
  });
});

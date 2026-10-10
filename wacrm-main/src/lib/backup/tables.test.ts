import { describe, expect, it } from "vitest";

import { REDACTED, backupFileName, cleanRow, tablesFor } from "./tables";

describe("backup tables", () => {
  it("keeps platform data out of account backups", () => {
    expect(tablesFor("account").some((t) => t.name === "platform_users")).toBe(false);
    expect(tablesFor("full").some((t) => t.name === "platform_users")).toBe(true);
  });

  it("redacts secrets and drops embeddings", () => {
    expect(cleanRow("whatsapp_config", { id: "1", access_token: "abc", verify_token: null })).toEqual({
      id: "1",
      access_token: REDACTED,
      verify_token: null,
    });
    expect(cleanRow("ai_knowledge_chunks", { id: "1", content: "x", embedding: "[0.1]" })).toEqual({
      id: "1",
      content: "x",
    });
    expect(cleanRow("contacts", { name: "Gru" })).toEqual({ name: "Gru" });
  });

  it("names the file after the account and time", () => {
    const now = new Date(2026, 9, 10, 14, 32);
    expect(backupFileName("account", "Acme Gold & Co", now)).toBe("wacrm-backup-acme-gold-co-2026-10-10-1432.json");
    expect(backupFileName("full", null, now)).toBe("wacrm-backup-full-2026-10-10-1432.json");
  });
});

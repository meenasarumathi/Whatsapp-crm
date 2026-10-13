import { describe, expect, it } from "vitest";

import { aiMessageKey, apiMessageKey, automationMessageKey, broadcastMessageKey, flowMessageKey } from "./keys";
import { dateBounds, ledgerToCsv, parseLedgerFilters } from "./report";

describe("message keys (one key = one logical message)", () => {
  it("are stable where the engine has a stable id", () => {
    expect(aiMessageKey("wamid.1")).toBe("ai:wamid.1");
    expect(automationMessageKey("log1", "step1")).toBe("auto:log1:step1");
    expect(broadcastMessageKey("r1")).toBe("bc:r1");
    expect(apiMessageKey("acct", "order-42")).toBe("api:acct:order-42");
  });

  it("are unique where repeats are legitimate or no id exists", () => {
    expect(flowMessageKey("run", "n")).not.toBe(flowMessageKey("run", "n"));
    expect(aiMessageKey(null)).not.toBe(aiMessageKey(null));
    expect(apiMessageKey("acct", "bad key with spaces")).toMatch(/^api:[0-9a-f-]{36}$/);
  });
});

describe("report filters and CSV", () => {
  it("parses and bounds a date range inclusively", () => {
    const f = parseLedgerFilters(new URLSearchParams("from=2026-10-01&to=2026-10-10&type=grant,usage_reserve"));
    expect(f.types).toEqual(["grant", "usage_reserve"]);
    expect(dateBounds(f)).toEqual({ gte: "2026-10-01T00:00:00.000Z", lt: "2026-10-11T00:00:00.000Z" });
  });

  it("writes tokens next to units and neutralises spreadsheet formulas", () => {
    const csv = ledgerToCsv([
      { created_at: "t", account_id: "a", account_name: "=HYPERLINK(\"x\")", entry_type: "grant", amount_units: 1500, balance_after_units: 1500, reason: "a, b" },
    ]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain("1500,1.5,1500,1.5");
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain('"a, b"');
  });
});

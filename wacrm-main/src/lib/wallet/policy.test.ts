import { describe, expect, it } from "vitest";

import { canWallet, classifyProviderFailure, type WalletAction, type WalletActor } from "./policy";
import { MetaApiError } from "@/lib/whatsapp/meta-api";

const customer: WalletActor = { platformRole: "subscriber", accountRole: "owner" };
const agent: WalletActor = { platformRole: "subscriber", accountRole: "agent" };
const admin1: WalletActor = { platformRole: "admin1", accountRole: "owner" };
const admin2: WalletActor = { platformRole: "admin2", accountRole: "agent" };
const superAdmin: WalletActor = { platformRole: "super_admin", accountRole: "owner" };

const SUPER_ONLY: WalletAction[] = ["grant", "deduct", "change_rate", "change_features", "resolve_reconciliation"];
const ADMIN: WalletAction[] = ["view_all_accounts", "view_reports", "decide_recharge", "view_proof"];

describe("4. authorization matrix", () => {
  it("customer: own wallet and recharge requests only", () => {
    expect(canWallet(customer, "view_own_wallet")).toBe(true);
    expect(canWallet(customer, "submit_recharge")).toBe(true);
    for (const a of [...ADMIN, ...SUPER_ONLY]) expect(canWallet(customer, a)).toBe(false);
  });

  it("a non-owner member can't even see the full wallet", () => {
    expect(canWallet(agent, "view_own_wallet")).toBe(false);
    expect(canWallet(agent, "submit_recharge")).toBe(false);
  });

  it.each([["admin1", admin1], ["admin2", admin2]] as const)(
    "%s: reports and approvals, but no grant / deduct / rate / switches",
    (_name, actor) => {
      for (const a of ADMIN) expect(canWallet(actor, a)).toBe(true);
      for (const a of SUPER_ONLY) expect(canWallet(actor, a)).toBe(false);
    },
  );

  it("super_admin can do everything", () => {
    for (const a of [...ADMIN, ...SUPER_ONLY, "view_own_wallet", "submit_recharge"] as WalletAction[]) {
      expect(canWallet(superAdmin, a)).toBe(true);
    }
  });
});

describe("provider failure classification", () => {
  it("a 4xx from Meta means definitely not sent (refund)", () => {
    expect(classifyProviderFailure(new MetaApiError("bad recipient", { httpStatus: 400, code: 131026 }))).toBe("not_sent");
    expect(classifyProviderFailure(new MetaApiError("rate", { httpStatus: 429 }))).toBe("not_sent");
  });

  it("5xx, network errors and unknown failures are ambiguous (keep reserved)", () => {
    expect(classifyProviderFailure(new MetaApiError("oops", { httpStatus: 503 }))).toBe("ambiguous");
    expect(classifyProviderFailure(new TypeError("fetch failed"))).toBe("ambiguous");
    expect(classifyProviderFailure(new Error("Cannot read properties of undefined"))).toBe("ambiguous");
    expect(classifyProviderFailure(null)).toBe("ambiguous");
  });
});

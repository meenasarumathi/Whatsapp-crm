import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AutomatedSendBlockedError, sendWithCharge } from "./charge";
import { MetaApiError } from "@/lib/whatsapp/meta-api";

/**
 * In-memory stand-in for the wallet functions in migration 045, enough
 * to drive sendWithCharge: balance, one charge row per key, ledger.
 * The real SQL (locking, concurrency) is exercised in db.test.ts.
 */
function fakeWallet(opts: {
  balance: number;
  features?: Partial<Record<string, boolean>>;
  notMigrated?: boolean;
  unlimited?: boolean;
}) {
  const state = {
    balance: opts.balance,
    charges: new Map<string, string>(),
    ledger: [] as { type: string; units: number }[],
    rpcCalls: [] as string[],
  };
  const err = (code: string) => ({ code, message: code });
  const db = {
    from: () => {
      const q = {
        feature: "",
        select: () => q,
        eq: (col: string, v: string) => {
          if (col === "feature") q.feature = v;
          return q;
        },
        maybeSingle: async () => {
          if (opts.notMigrated) return { data: null, error: err("PGRST205") };
          const enabled = opts.features?.[q.feature];
          return { data: enabled === undefined ? null : { enabled }, error: null };
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, string>) => {
      state.rpcCalls.push(fn);
      if (opts.notMigrated) return { data: null, error: err("PGRST202") };
      const key = args.p_message_id;
      const status = state.charges.get(key);
      switch (fn) {
        case "token_reserve_charge": {
          if (opts.unlimited) return { data: [{ outcome: "unlimited" }], error: null };
          if (status === "reserved") return { data: [{ outcome: "in_flight" }], error: null };
          if (status === "sent") return { data: [{ outcome: "already_sent" }], error: null };
          if (status === "needs_reconciliation") return { data: [{ outcome: "needs_reconciliation" }], error: null };
          if (state.balance < 500) return { data: [{ outcome: "insufficient_tokens" }], error: null };
          state.balance -= 500;
          state.ledger.push({ type: "usage_reserve", units: -500 });
          state.charges.set(key, "reserved");
          return { data: [{ outcome: "reserved", charge_id: "c1", balance_units: state.balance }], error: null };
        }
        case "token_confirm_charge":
          state.charges.set(key, "sent");
          state.ledger.push({ type: "usage_confirm", units: 0 });
          return { data: "confirmed", error: null };
        case "token_release_charge":
          state.charges.set(key, "released");
          state.balance += 500;
          state.ledger.push({ type: "usage_release", units: 500 });
          return { data: "released", error: null };
        case "token_mark_reconciliation":
          state.charges.set(key, "needs_reconciliation");
          return { data: "marked", error: null };
      }
      return { data: null, error: err("unknown") };
    },
  } as unknown as SupabaseClient;
  return { db, state };
}

const charge = (key = "auto:log:step", source: "workflow" | "broadcast" | "ai_agent" | "chatbot" | "api" = "workflow") => ({
  source,
  messageKey: key,
});

describe("5. each automated send costs exactly 500 units", () => {
  it("reserves 500, sends once, confirms with a 0-unit audit row", async () => {
    const { db, state } = fakeWallet({ balance: 2000 });
    const send = vi.fn(async () => "wamid.1");
    await expect(sendWithCharge({ db, accountId: "a", charge: charge(), send })).resolves.toBe("wamid.1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.balance).toBe(1500);
    expect(state.ledger).toEqual([
      { type: "usage_reserve", units: -500 },
      { type: "usage_confirm", units: 0 },
    ]);
    expect(state.charges.get("auto:log:step")).toBe("sent");
  });
});

describe("6. zero balance blocks automated sends", () => {
  it.each(["ai_agent", "workflow", "chatbot", "broadcast", "api"] as const)("%s is blocked and not sent", async (source) => {
    const { db, state } = fakeWallet({ balance: 0 });
    const send = vi.fn(async () => "wamid");
    const p = sendWithCharge({ db, accountId: "a", charge: charge(`${source}:1`, source), send });
    await expect(p).rejects.toBeInstanceOf(AutomatedSendBlockedError);
    await expect(p).rejects.toMatchObject({ reason: "insufficient_tokens" });
    expect(send).not.toHaveBeenCalled();
    expect(state.balance).toBe(0);
    expect(state.ledger).toEqual([]);
  });
});

describe("7. feature switch off", () => {
  it.each([
    ["chatbot", "chatbot"],
    ["workflow", "workflow"],
    ["ai_agent", "ai_agent"],
  ] as const)("%s off: no send, no charge, no reserve call", async (feature, source) => {
    const { db, state } = fakeWallet({ balance: 5000, features: { [feature]: false } });
    const send = vi.fn(async () => "wamid");
    await expect(
      sendWithCharge({ db, accountId: "a", charge: charge("k", source), send }),
    ).rejects.toMatchObject({ reason: "feature_disabled" });
    expect(send).not.toHaveBeenCalled();
    expect(state.rpcCalls).toEqual([]);
    expect(state.balance).toBe(5000);
  });

  it("broadcasts have no switch and are still charged", async () => {
    const { db, state } = fakeWallet({ balance: 500, features: { chatbot: false, workflow: false, ai_agent: false } });
    await sendWithCharge({ db, accountId: "a", charge: charge("bc:r1", "broadcast"), send: async () => "w" });
    expect(state.balance).toBe(0);
  });
});

describe("9. duplicate callback / retry of the same message", () => {
  it("a second attempt with the same key neither sends nor charges again", async () => {
    const { db, state } = fakeWallet({ balance: 5000 });
    const send = vi.fn(async () => "wamid.1");
    await sendWithCharge({ db, accountId: "a", charge: charge("bc:r1", "broadcast"), send });
    await expect(
      sendWithCharge({ db, accountId: "a", charge: charge("bc:r1", "broadcast"), send }),
    ).rejects.toMatchObject({ reason: "already_sent" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.balance).toBe(4500);
  });
});

describe("10. ambiguous provider result", () => {
  it.each([
    ["timeout / dropped connection", new TypeError("fetch failed")],
    ["5xx without a message id", new MetaApiError("Service unavailable", { httpStatus: 503 })],
  ])("%s → needs_reconciliation, stays reserved, never resent", async (_label, failure) => {
    const { db, state } = fakeWallet({ balance: 1000 });
    const send = vi.fn(async () => {
      throw failure;
    });
    await expect(sendWithCharge({ db, accountId: "a", charge: charge("k"), send })).rejects.toBe(failure);
    expect(state.charges.get("k")).toBe("needs_reconciliation");
    expect(state.balance).toBe(500);

    const retry = vi.fn(async () => "wamid");
    await expect(sendWithCharge({ db, accountId: "a", charge: charge("k"), send: retry })).rejects.toMatchObject({
      reason: "needs_reconciliation",
    });
    expect(retry).not.toHaveBeenCalled();
    expect(state.balance).toBe(500);
  });
});

describe("11. definitive failure", () => {
  it("a 4xx from Meta releases the reservation and restores the balance", async () => {
    const { db, state } = fakeWallet({ balance: 1000 });
    const failure = new MetaApiError("Recipient phone number not valid", { httpStatus: 400, code: 131026 });
    await expect(
      sendWithCharge({ db, accountId: "a", charge: charge("k"), send: async () => { throw failure; } }),
    ).rejects.toBe(failure);
    expect(state.charges.get("k")).toBe("released");
    expect(state.balance).toBe(1000);
    expect(state.ledger.map((l) => l.type)).toEqual(["usage_reserve", "usage_release"]);
  });
});

describe("before migration 045 is applied", () => {
  it("sends without metering instead of stopping every automation", async () => {
    const { db } = fakeWallet({ balance: 0, notMigrated: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendWithCharge({ db, accountId: "a", charge: charge(), send: async () => "w" })).resolves.toBe("w");
    warn.mockRestore();
  });
});

describe("platform owner account (migration 046)", () => {
  it("is unlimited: sends at zero balance with no charge, confirm or ledger row", async () => {
    const { db, state } = fakeWallet({ balance: 0, unlimited: true });
    const send = vi.fn(async () => "wamid.owner");
    await expect(sendWithCharge({ db, accountId: "owner", charge: charge("ai:x", "ai_agent"), send })).resolves.toBe("wamid.owner");
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.rpcCalls).toEqual(["token_reserve_charge"]);
    expect(state.ledger).toEqual([]);
    expect(state.balance).toBe(0);
  });

  it("still respects a switched-off feature", async () => {
    const { db } = fakeWallet({ balance: 0, unlimited: true, features: { chatbot: false } });
    await expect(
      sendWithCharge({ db, accountId: "owner", charge: charge("flow:1", "chatbot"), send: async () => "w" }),
    ).rejects.toMatchObject({ reason: "feature_disabled" });
  });
});

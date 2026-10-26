/**
 * 4 / 13 / 15. Token wallet API routes: server-side authorization,
 * account isolation and input validation.
 *
 * The session (account + roles) is mocked; the database is a recorder
 * that captures every rpc and every filter, so the tests can prove the
 * routes (a) refuse callers without the right role BEFORE touching the
 * database and (b) scope customer reads to the session's account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  session: { userId: "u-cust", accountId: "acct-A", role: "owner" as string },
  platformRole: "subscriber" as string,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  filters: [] as Array<{ table: string; col: string; val: unknown }>,
  rpcResult: null as unknown,
  rows: {} as Record<string, unknown>,
  uploads: [] as string[],
}));

vi.mock("@/lib/auth/account", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return {
    ...actual,
    getCurrentAccount: vi.fn(async () => ({
      db: {},
      userId: S.session.userId,
      accountId: S.session.accountId,
      role: S.session.role,
      account: { id: S.session.accountId, name: "Acme" },
    })),
  };
});

vi.mock("@/lib/platform/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform/server")>("@/lib/platform/server");
  return { ...actual, loadPlatformUser: vi.fn(async () => ({ platform_role: S.platformRole })) };
});

vi.mock("@/lib/wallet/charge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/wallet/charge")>("@/lib/wallet/charge");
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "order", "limit", "gte", "lt", "in", "range", "update", "upsert"]) b[m] = vi.fn(chain);
    b.eq = vi.fn((col: string, val: unknown) => {
      S.filters.push({ table, col, val });
      return b;
    });
    const result = { data: S.rows[table] ?? null, error: null, count: 0 };
    b.maybeSingle = vi.fn(async () => result);
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ ...result, data: Array.isArray(S.rows[table]) ? S.rows[table] : [] });
    return b;
  };
  const db = {
    from: vi.fn((t: string) => builder(t)),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      S.rpc.push({ fn, args });
      return { data: S.rpcResult, error: null };
    }),
  };
  return { ...actual, walletAdminClient: () => db };
});

vi.mock("@/lib/wallet/proof-store", () => ({
  putProof: vi.fn(async (key: string) => {
    S.uploads.push(key);
  }),
  removeProof: vi.fn(async () => undefined),
  readProof: vi.fn(async () => ({ data: Buffer.from("png"), contentType: "image/png" })),
}));

import { GET as walletGET } from "./route";
import { POST as rechargePOST } from "./recharge/route";
import { GET as adminGET, POST as adminPOST } from "./admin/route";
import { GET as ledgerGET } from "./admin/ledger/route";
import { GET as proofGET } from "./admin/proof/[id]/route";

const OTHER_ACCOUNT = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "22222222-2222-2222-2222-222222222222";

function as(platformRole: string, accountRole = "owner", accountId = "acct-A") {
  S.platformRole = platformRole;
  S.session = { userId: `u-${platformRole}`, accountId, role: accountRole };
}
const admin = (body: Record<string, unknown>) =>
  adminPOST(new Request("http://x/api/wallet/admin", { method: "POST", body: JSON.stringify(body) }));
let callNo = 0;
function recharge(fields: Record<string, string | Blob>) {
  // A fresh user per call so the 5-per-10-minutes recharge rate limit
  // (tested separately below) doesn't trip across unrelated tests.
  S.session = { ...S.session, userId: `${S.session.userId.split("#")[0]}#${++callNo}` };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return rechargePOST(new Request("http://x/api/wallet/recharge", { method: "POST", body: form }));
}

beforeEach(() => {
  S.rpc.length = 0;
  S.filters.length = 0;
  S.uploads.length = 0;
  S.rows = {};
  S.rpcResult = null;
});

describe("4. authorization matrix (server-side)", () => {
  const superOnly = [
    { action: "grant", account_id: OTHER_ACCOUNT, tokens: "10", reason: "x" },
    { action: "deduct", account_id: OTHER_ACCOUNT, tokens: "10", reason: "x" },
    { action: "set_rate", rate_num: "2", rate_den: "1" },
    { action: "set_feature", account_id: OTHER_ACCOUNT, feature: "chatbot", enabled: false },
    { action: "resolve", message_id: "k", outcome: "released", reason: "x" },
  ];

  it.each([...superOnly, { action: "decide", request_id: REQUEST_ID, approve: true }])(
    "customer cannot $action",
    async (body) => {
      as("subscriber", "owner");
      const res = await admin(body);
      expect(res.status).toBe(403);
      expect(S.rpc).toEqual([]);
    },
  );

  it("customer cannot open the admin overview or reports", async () => {
    as("subscriber", "owner");
    expect((await adminGET()).status).toBe(403);
    expect((await ledgerGET(new Request("http://x/api/wallet/admin/ledger"))).status).toBe(403);
  });

  it.each([["admin1"], ["admin2"]])("%s cannot grant, deduct, change the rate or switches", async (role) => {
    for (const body of superOnly) {
      as(role, "owner");
      const res = await admin(body);
      expect(res.status, `${role} ${body.action}`).toBe(403);
    }
    expect(S.rpc).toEqual([]);
  });

  it.each([["admin1"], ["admin2"]])("%s can approve a recharge", async (role) => {
    as(role, "agent");
    S.rpcResult = "approved";
    const res = await admin({ action: "decide", request_id: REQUEST_ID, approve: true, note: "seen" });
    expect(res.status).toBe(200);
    expect(S.rpc).toEqual([
      { fn: "token_decide_recharge", args: { p_request_id: REQUEST_ID, p_actor: `u-${role}`, p_approve: true, p_note: "seen" } },
    ]);
  });

  it("super_admin can grant, deduct and change the rate", async () => {
    as("super_admin");
    S.rpcResult = [{ balance_units: 10000 }];
    expect((await admin({ action: "grant", account_id: OTHER_ACCOUNT, tokens: "10", reason: "bonus" })).status).toBe(200);
    expect((await admin({ action: "deduct", account_id: OTHER_ACCOUNT, tokens: "2.5", reason: "fix" })).status).toBe(200);
    expect((await admin({ action: "set_rate", rate_num: "3", rate_den: "2" })).status).toBe(200);
    expect(S.rpc.map((r) => [r.fn, r.args.p_units ?? r.args.p_rate_num])).toEqual([
      ["token_grant", 10000],
      ["token_deduct", 2500],
      ["token_set_rate", 3],
    ]);
  });

  it("rejecting needs a note; a decided request returns 409", async () => {
    as("super_admin");
    expect((await admin({ action: "decide", request_id: REQUEST_ID, approve: false, note: " " })).status).toBe(400);
    S.rpcResult = "already_decided";
    expect((await admin({ action: "decide", request_id: REQUEST_ID, approve: true })).status).toBe(409);
  });
});

describe("13. account isolation", () => {
  it("a customer's wallet reads are scoped to the session account", async () => {
    as("subscriber", "owner", "acct-A");
    const res = await walletGET();
    expect(res.status).toBe(200);
    // Balance via token_account_status, everything else via filtered reads —
    // all of it for the session's account and nothing else.
    expect(S.rpc).toEqual([{ fn: "token_account_status", args: { p_account_id: "acct-A" } }]);
    const accountFilters = S.filters.filter((f) => f.col === "account_id");
    expect(accountFilters.length).toBeGreaterThanOrEqual(4);
    expect(accountFilters.every((f) => f.val === "acct-A")).toBe(true);
  });

  it("a non-owner member sees only the balance", async () => {
    as("subscriber", "agent");
    const json = await (await walletGET()).json();
    expect(json.is_owner).toBe(false);
    expect(json).not.toHaveProperty("ledger");
    expect(json).not.toHaveProperty("requests");
  });

  it("another account's proof is 404 for a customer, visible to an admin", async () => {
    S.rows.recharge_requests = { account_id: OTHER_ACCOUNT, proof_storage_key: `${OTHER_ACCOUNT}/p.png` };
    as("subscriber", "owner", "acct-A");
    const ctx = { params: Promise.resolve({ id: REQUEST_ID }) };
    expect((await proofGET(new Request("http://x"), ctx)).status).toBe(404);
    as("admin2", "agent", "acct-A");
    expect((await proofGET(new Request("http://x"), { params: Promise.resolve({ id: REQUEST_ID }) })).status).toBe(200);
  });

  it("serves the proof file itself only after the same permission check", async () => {
    S.rows.recharge_requests = { account_id: OTHER_ACCOUNT, proof_storage_key: `${OTHER_ACCOUNT}/p.png` };
    const dl = () => proofGET(new Request("http://x?download=1"), { params: Promise.resolve({ id: REQUEST_ID }) });
    as("subscriber", "owner", "acct-A");
    expect((await dl()).status).toBe(404);
    as("admin2", "agent", "acct-A");
    const res = await dl();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("recharge requests use the session account, ignoring any account in the form", async () => {
    as("subscriber", "owner", "acct-A");
    S.rpcResult = [{ id: "r", status: "pending", amount_paise: 50000, tokens_units: 500000 }];
    const res = await recharge({ amount_rupees: "500", account_id: OTHER_ACCOUNT });
    expect(res.status).toBe(201);
    expect(S.rpc[0]).toMatchObject({ fn: "token_submit_recharge", args: { p_account_id: "acct-A", p_amount_paise: 50000 } });
  });

  it("only the account owner can submit a recharge", async () => {
    as("subscriber", "admin");
    expect((await recharge({ amount_rupees: "500" })).status).toBe(403);
    expect(S.rpc).toEqual([]);
  });
});

describe("recharge rate limit", () => {
  it("the 6th request inside 10 minutes from one user gets 429", async () => {
    as("subscriber", "owner");
    S.rpcResult = [{ id: "r", status: "pending", amount_paise: 100, tokens_units: 1000 }];
    const form = () => {
      const f = new FormData();
      f.set("amount_rupees", "1");
      return new Request("http://x/api/wallet/recharge", { method: "POST", body: f });
    };
    S.session = { ...S.session, userId: "u-rate-limit" };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await rechargePOST(form())).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("15. input validation at the API", () => {
  beforeEach(() => as("subscriber", "owner"));

  it.each(["-5", "0", "abc", "1.234", "NaN", "100000000"])("rejects amount %s", async (amount) => {
    expect((await recharge({ amount_rupees: amount })).status).toBe(400);
    expect(S.rpc).toEqual([]);
  });

  it("rejects proof files of the wrong type, size, or disguised content", async () => {
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46])], "a.gif", { type: "image/gif" });
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "a.png", { type: "image/png" });
    const fake = new File([new TextEncoder().encode("<script>")], "a.png", { type: "image/png" });
    for (const proof of [gif, big, fake]) {
      expect((await recharge({ amount_rupees: "100", proof })).status).toBe(400);
    }
    expect(S.uploads).toEqual([]);
    expect(S.rpc).toEqual([]);
  });

  it("stores a valid proof privately under the account's folder", async () => {
    S.rpcResult = [{ id: "r", status: "pending", amount_paise: 10000, tokens_units: 100000 }];
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], "p.png", { type: "image/png" });
    expect((await recharge({ amount_rupees: "100", proof: png })).status).toBe(201);
    expect(S.uploads[0]).toMatch(/^acct-A\/[0-9a-f-]+\.png$/);
  });

  it("admin actions validate amounts, reasons and ids", async () => {
    as("super_admin");
    for (const body of [
      { action: "grant", account_id: OTHER_ACCOUNT, tokens: "abc", reason: "x" },
      { action: "grant", account_id: OTHER_ACCOUNT, tokens: "-1", reason: "x" },
      { action: "grant", account_id: OTHER_ACCOUNT, tokens: "10", reason: "" },
      { action: "deduct", account_id: "not-a-uuid", tokens: "1", reason: "x" },
      { action: "set_rate", rate_num: "0", rate_den: "1" },
      { action: "set_feature", account_id: OTHER_ACCOUNT, feature: "broadcast", enabled: false },
      { action: "nope" },
    ]) {
      expect((await admin(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(S.rpc).toEqual([]);
  });

  it("report filters are validated", async () => {
    as("admin1");
    for (const q of ["account_id=x", "from=2026-13-01", "from=2026-10-10&to=2026-10-01", "type=bogus"]) {
      expect((await ledgerGET(new Request(`http://x/api/wallet/admin/ledger?${q}`))).status, q).toBe(400);
    }
  });
});

describe("Adjust Wallet (₹ credit / debit)", () => {
  it.each([["subscriber"], ["admin1"], ["admin2"]])("%s cannot adjust a wallet", async (role) => {
    as(role, "owner");
    expect((await admin({ action: "adjust", account_id: OTHER_ACCOUNT, kind: "credit", amount_rupees: "500", reason: "x" })).status).toBe(403);
    expect(S.rpc).toEqual([]);
  });

  it("super admin credits and debits in rupees (converted in the database)", async () => {
    as("super_admin");
    S.rpcResult = [{ units: 500000, balance_units: 510340 }];
    const res = await admin({ action: "adjust", account_id: OTHER_ACCOUNT, kind: "credit", amount_rupees: "500", reason: "Admin manual balance adjustment" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ units: 500000, balance_units: 510340 });
    expect(S.rpc[0]).toEqual({
      fn: "token_adjust",
      args: { p_account_id: OTHER_ACCOUNT, p_kind: "credit", p_amount_paise: 50000, p_actor: "u-super_admin", p_reason: "Admin manual balance adjustment" },
    });
    expect((await admin({ action: "adjust", account_id: OTHER_ACCOUNT, kind: "debit", amount_rupees: "10.50", reason: "fix" })).status).toBe(200);
    expect(S.rpc[1].args).toMatchObject({ p_kind: "debit", p_amount_paise: 1050 });
  });

  it("validates kind, amount and reason", async () => {
    as("super_admin");
    for (const body of [
      { kind: "refund", amount_rupees: "5", reason: "x" },
      { kind: "credit", amount_rupees: "-5", reason: "x" },
      { kind: "credit", amount_rupees: "abc", reason: "x" },
      { kind: "credit", amount_rupees: "10000001", reason: "x" },
      { kind: "credit", amount_rupees: "5", reason: " " },
    ]) {
      expect((await admin({ action: "adjust", account_id: OTHER_ACCOUNT, ...body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(S.rpc).toEqual([]);
  });
});

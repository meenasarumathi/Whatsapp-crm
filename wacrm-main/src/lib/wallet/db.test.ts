/**
 * Token wallet — database tests against REAL PostgreSQL.
 *
 * These run migration 045 (and its rollback) on a throwaway database
 * and call the SQL functions directly, including from many parallel
 * connections, so locking and idempotency are tested for real.
 *
 * Opt-in (they need a Postgres server):
 *   TOKEN_WALLET_TEST_PG=1 npx vitest run src/lib/wallet/db.test.ts
 * Optional: TOKEN_WALLET_PGHOST (default /tmp), TOKEN_WALLET_PSQL /
 * TOKEN_WALLET_CREATEDB / TOKEN_WALLET_DROPDB (default from PATH).
 * The database `wacrm_token_wallet_test` is created and dropped here;
 * nothing else on the server is touched.
 */

import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ENABLED = process.env.TOKEN_WALLET_TEST_PG === "1";
const HOST = process.env.TOKEN_WALLET_PGHOST ?? "/tmp";
const PSQL = process.env.TOKEN_WALLET_PSQL ?? "psql";
const CREATEDB = process.env.TOKEN_WALLET_CREATEDB ?? "createdb";
const DROPDB = process.env.TOKEN_WALLET_DROPDB ?? "dropdb";
const DB = "wacrm_token_wallet_test";

const ROOT = process.cwd();
const STUB = join(ROOT, "supabase/tests/token-wallet/stub.sql");
const UP = join(ROOT, "supabase/migrations/045_token_wallet.sql");
const DOWN = join(ROOT, "supabase/rollbacks/045_token_wallet.down.sql");
const UP_046 = join(ROOT, "supabase/migrations/046_wallet_platform_owner.sql");
const DOWN_046 = join(ROOT, "supabase/rollbacks/046_wallet_platform_owner.down.sql");

function psqlArgs(extra: string[]) {
  return ["-h", HOST, "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-At", ...extra];
}
/** Run SQL, return trimmed stdout. Throws with stderr on SQL error. */
function sql(query: string): string {
  return execFileSync(PSQL, psqlArgs(["-c", query]), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function sqlFile(path: string) {
  execFileSync(PSQL, psqlArgs(["-f", path]), { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } });
}
/** Same, on its own connection — for parallel calls. */
async function sqlAsync(query: string): Promise<string> {
  const { stdout } = await run(PSQL, psqlArgs(["-c", query]), { encoding: "utf8" });
  return stdout.trim();
}
function sqlError(query: string): string {
  try {
    sql(query);
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
  return "";
}
function freshDb() {
  execFileSync(DROPDB, ["-h", HOST, "--if-exists", DB], { stdio: "ignore" });
  execFileSync(CREATEDB, ["-h", HOST, DB], { stdio: "ignore" });
  sqlFile(STUB);
}
const balance = (acct: string) => Number(sql(`select balance_units from token_wallets where account_id='${acct}'`));
const reserve = (acct: string, key: string, source = "workflow") =>
  sql(`select outcome from token_reserve_charge('${acct}','${key}','${source}')`);

describe.skipIf(!ENABLED)("token wallet — PostgreSQL", () => {
  afterAll(() => {
    execFileSync(DROPDB, ["-h", HOST, "--if-exists", DB], { stdio: "ignore" });
  });

  describe("14. migrations", () => {
    it("applies on an empty DB, rolls back, and re-applies", () => {
      freshDb();
      sqlFile(UP);
      expect(sql("select rate_num || '/' || rate_den from token_settings")).toBe("1/1");
      expect(sql("select count(*) from token_wallets")).toBe("0");
      sqlFile(UP_046);
      sqlFile(UP_046); // re-runnable
      expect(sql("select to_regprocedure('token_adjust(uuid,text,bigint,uuid,text)') is not null")).toBe("t");
      sqlFile(DOWN_046);
      expect(sql("select to_regprocedure('token_adjust(uuid,text,bigint,uuid,text)') is null")).toBe("t");
      sqlFile(DOWN);
      expect(sql("select to_regclass('public.token_ledger') is null")).toBe("t");
      sqlFile(UP);
      sqlFile(UP_046);
      expect(sql("select to_regclass('public.token_ledger') is not null")).toBe("t");
    });

    it("backfills existing accounts at 0 with every feature on, idempotently", () => {
      freshDb();
      sql("insert into accounts(name) values ('a'),('b'),('c')");
      sqlFile(UP);
      sqlFile(UP); // re-run is a no-op
      expect(sql("select count(*), sum(balance_units) from token_wallets")).toBe("3|0");
      expect(sql("select count(*) from account_feature_flags where enabled")).toBe("9");
      // New accounts are bootstrapped by trigger.
      sql("insert into accounts(name) values ('d')");
      expect(sql("select count(*) from token_wallets")).toBe("4");
      sqlFile(DOWN);
      expect(sql("select count(*) from accounts")).toBe("4"); // rollback keeps accounts
      sqlFile(UP);
      expect(sql("select count(*) from token_wallets")).toBe("4");
    });
  });

  describe("functions", () => {
    let A = "";
    let B = "";
    let ADMIN = "";

    beforeAll(() => {
      freshDb();
      sqlFile(UP);
      sqlFile(UP_046);
    });

    beforeEach(() => {
      sql("truncate message_charges, recharge_requests, token_rate_changes cascade");
      // token_ledger is append-only for rows; TRUNCATE is a table-level reset for tests.
      sql("truncate token_ledger cascade");
      sql("truncate platform_users");
      sql("update token_settings set rate_num = 1, rate_den = 1");
      A = sql("insert into accounts(name) values ('A') returning id");
      B = sql("insert into accounts(name) values ('B') returning id");
      ADMIN = sql("insert into auth.users(email) values ('admin@x') returning id");
    });

    it("2. grant needs a reason; deduction needs a reason and can't go negative", () => {
      expect(sqlError(`select token_grant('${A}', 1000, '${ADMIN}', '  ')`)).toContain("reason_required");
      sql(`select token_grant('${A}', 1000, '${ADMIN}', 'welcome bonus')`);
      expect(balance(A)).toBe(1000);
      expect(sqlError(`select token_deduct('${A}', 500, '${ADMIN}', null)`)).toContain("reason_required");
      expect(sqlError(`select token_deduct('${A}', 1500, '${ADMIN}', 'too much')`)).toContain("insufficient_balance");
      expect(balance(A)).toBe(1000);
      sql(`select token_deduct('${A}', 400, '${ADMIN}', 'duplicate grant')`);
      expect(balance(A)).toBe(600);
      expect(sql(`select string_agg(entry_type || ':' || amount_units || ':' || coalesce(rate_num::text, ''), ',' order by created_at) from token_ledger where account_id='${A}'`))
        .toBe("grant:1000:1,admin_deduct:-400:");
    });

    it("1. a rate change affects only requests submitted afterwards", () => {
      const r1 = sql(`select id from token_submit_recharge('${A}', null, 10000, 'UPI1', null)`); // ₹100
      sql(`select token_set_rate(2, 1, '${ADMIN}')`);
      const r2 = sql(`select id from token_submit_recharge('${A}', null, 10000, 'UPI2', null)`);
      expect(sql(`select tokens_units from recharge_requests where id='${r1}'`)).toBe("100000");
      expect(sql(`select tokens_units from recharge_requests where id='${r2}'`)).toBe("200000");
      sql(`select token_decide_recharge('${r1}', '${ADMIN}', true, null)`);
      expect(balance(A)).toBe(100000);
      expect(sql("select count(*) from token_rate_changes")).toBe("1");
    });

    it("3. recharge: approve credits once; re-approve, reject and changes after a decision do nothing", () => {
      const r = sql(`select id from token_submit_recharge('${A}', null, 5000, null, null)`); // ₹50
      expect(sql(`select status from recharge_requests where id='${r}'`)).toBe("pending");
      expect(sql(`select token_decide_recharge('${r}', '${ADMIN}', true, 'seen in GPay')`)).toBe("approved");
      expect(balance(A)).toBe(50000);
      expect(sql(`select token_decide_recharge('${r}', '${ADMIN}', true, null)`)).toBe("already_approved");
      expect(sql(`select token_decide_recharge('${r}', '${ADMIN}', false, 'oops')`)).toBe("already_decided");
      expect(balance(A)).toBe(50000);
      expect(sql(`select count(*) from token_ledger where entry_type='recharge_credit' and reference='${r}'`)).toBe("1");
      expect(sql(`select decided_by='${ADMIN}', decided_at is not null, rate_tokens_per_rupee_num from recharge_requests where id='${r}'`)).toBe("t|t|1");

      const rej = sql(`select id from token_submit_recharge('${A}', null, 5000, null, null)`);
      expect(sqlError(`select token_decide_recharge('${rej}', '${ADMIN}', false, '')`)).toContain("note_required");
      expect(sql(`select token_decide_recharge('${rej}', '${ADMIN}', false, 'no payment found')`)).toBe("rejected");
      expect(sql(`select token_decide_recharge('${rej}', '${ADMIN}', true, null)`)).toBe("already_decided");
      expect(balance(A)).toBe(50000);
    });

    it("3b. two admins approving the same request at once credit it once", async () => {
      const r = sql(`select id from token_submit_recharge('${A}', null, 10000, null, null)`);
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => sqlAsync(`select token_decide_recharge('${r}', '${ADMIN}', true, null)`)),
      );
      expect(outcomes.filter((o) => o === "approved")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "already_approved")).toHaveLength(7);
      expect(balance(A)).toBe(100000);
    });

    it("5. a send costs exactly 500 units; confirm adds a 0-unit audit row", () => {
      sql(`select token_grant('${A}', 2000, '${ADMIN}', 'test')`);
      expect(reserve(A, "auto:l1:s1")).toBe("reserved");
      expect(balance(A)).toBe(1500);
      expect(sql(`select token_confirm_charge('auto:l1:s1', 'wamid.1')`)).toBe("confirmed");
      expect(balance(A)).toBe(1500);
      expect(sql(`select status, provider_message_id from message_charges where message_id='auto:l1:s1'`)).toBe("sent|wamid.1");
      expect(sql(`select string_agg(entry_type || ':' || amount_units, ',' order by created_at) from token_ledger where account_id='${A}' and entry_type like 'usage%'`))
        .toBe("usage_reserve:-500,usage_confirm:0");
    });

    it("6. zero balance: reserve fails, nothing is written", () => {
      expect(reserve(A, "ai:wamid.x", "ai_agent")).toBe("insufficient_tokens");
      sql(`select token_grant('${A}', 499, '${ADMIN}', 'just under')`);
      expect(reserve(A, "ai:wamid.x", "ai_agent")).toBe("insufficient_tokens");
      expect(sql("select count(*) from message_charges")).toBe("0");
      expect(balance(A)).toBe(499);
    });

    it("8. N parallel sends with balance for K < N → exactly K reserved and K charges", async () => {
      const N = 24;
      const K = 7;
      sql(`select token_grant('${A}', ${K * 500}, '${ADMIN}', 'exact budget')`);
      const outcomes = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          sqlAsync(`select outcome from token_reserve_charge('${A}','bc:r${i}','broadcast')`),
        ),
      );
      expect(outcomes.filter((o) => o === "reserved")).toHaveLength(K);
      expect(outcomes.filter((o) => o === "insufficient_tokens")).toHaveLength(N - K);
      expect(balance(A)).toBe(0);
      expect(sql(`select count(*) from message_charges where account_id='${A}'`)).toBe(String(K));
      expect(sql(`select count(*) from token_ledger where entry_type='usage_reserve'`)).toBe(String(K));
    });

    it("9. the same message retried in parallel → one charge row, one reservation", async () => {
      sql(`select token_grant('${A}', 10000, '${ADMIN}', 'plenty')`);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => sqlAsync(`select outcome from token_reserve_charge('${A}','ai:wamid.dup','ai_agent')`)),
      );
      expect(outcomes.filter((o) => o === "reserved")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "in_flight")).toHaveLength(9);
      expect(balance(A)).toBe(9500);
      sql(`select token_confirm_charge('ai:wamid.dup','wamid.out')`);
      expect(reserve(A, "ai:wamid.dup", "ai_agent")).toBe("already_sent");
      expect(sql(`select token_confirm_charge('ai:wamid.dup','wamid.out')`)).toBe("already_sent");
      expect(balance(A)).toBe(9500);
    });

    it("10. ambiguous: stays reserved, isn't resent, and reconciliation settles it either way", () => {
      sql(`select token_grant('${A}', 1000, '${ADMIN}', 'test')`);
      reserve(A, "flow:r:n:1", "chatbot");
      expect(sql(`select token_mark_reconciliation('flow:r:n:1', 'timeout')`)).toBe("marked");
      expect(reserve(A, "flow:r:n:1", "chatbot")).toBe("needs_reconciliation");
      expect(balance(A)).toBe(500);
      // Reviewer confirms it went out.
      expect(sql(`select token_confirm_charge('flow:r:n:1', null, '${ADMIN}', 'customer replied to it')`)).toBe("confirmed");
      expect(balance(A)).toBe(500);

      reserve(A, "flow:r:n:2", "chatbot");
      sql(`select token_mark_reconciliation('flow:r:n:2', '503')`);
      expect(balance(A)).toBe(0);
      expect(sql(`select token_release_charge('flow:r:n:2', 'not in chat', '${ADMIN}')`)).toBe("released");
      expect(balance(A)).toBe(500); // n:1 stays charged (it was sent); n:2 refunded
      expect(sql(`select token_release_charge('flow:r:n:2', 'again', '${ADMIN}')`)).toBe("already_released");
      expect(balance(A)).toBe(500);

      // The reconciliation job escalates charges stuck in 'reserved'.
      reserve(A, "flow:r:n:3", "chatbot");
      sql(`update message_charges set updated_at = now() - interval '1 hour' where message_id='flow:r:n:3'`);
      expect(sql(`select token_escalate_stale_charges(600)`)).toBe("1");
      expect(sql(`select status from message_charges where message_id='flow:r:n:3'`)).toBe("needs_reconciliation");
    });

    it("11. definitive failure: released and balance restored; a later retry may send", () => {
      sql(`select token_grant('${A}', 500, '${ADMIN}', 'test')`);
      reserve(A, "bc:r9", "broadcast");
      expect(balance(A)).toBe(0);
      expect(sql(`select token_release_charge('bc:r9', '400 invalid recipient')`)).toBe("released");
      expect(balance(A)).toBe(500);
      // Resume of the same recipient reuses the SAME row.
      expect(reserve(A, "bc:r9", "broadcast")).toBe("reserved");
      expect(sql(`select count(*) from message_charges where message_id='bc:r9'`)).toBe("1");
      expect(balance(A)).toBe(0);
    });

    it("13. a message key can't be used across accounts", () => {
      sql(`select token_grant('${A}', 1000, '${ADMIN}', 'test')`);
      sql(`select token_grant('${B}', 1000, '${ADMIN}', 'test')`);
      reserve(A, "api:shared", "api");
      expect(reserve(B, "api:shared", "api")).toBe("key_conflict");
      expect(balance(B)).toBe(1000);
    });

    it("046: the platform owner's account is unlimited — never charged", async () => {
      const owner = sql("insert into auth.users(email) values ('owner@x') returning id");
      sql(`insert into platform_users values ('${owner}', 'super_admin')`);
      const OWN = sql(`insert into accounts(name, owner_user_id) values ('Owner co', '${owner}') returning id`);
      expect(reserve(OWN, "ai:o1", "ai_agent")).toBe("unlimited");
      const many = await Promise.all(
        Array.from({ length: 5 }, (_, i) => sqlAsync(`select outcome from token_reserve_charge('${OWN}','bc:o${i}','broadcast')`)),
      );
      expect(new Set(many)).toEqual(new Set(["unlimited"]));
      expect(balance(OWN)).toBe(0);
      expect(sql(`select count(*) from message_charges where account_id='${OWN}'`)).toBe("0");
      expect(sql(`select count(*) from token_ledger where account_id='${OWN}'`)).toBe("0");
      expect(sql(`select unlimited, balance_units from token_account_status('${OWN}')`)).toBe("t|0");
      // A tenant is still metered.
      expect(reserve(A, "ai:t1", "ai_agent")).toBe("insufficient_tokens");
      expect(sql(`select unlimited from token_account_status('${A}')`)).toBe("f");
    });

    it("046: Adjust Wallet credits / debits rupees at the current rate, with a reason, never below zero", () => {
      sql(`select token_set_rate(2, 1, '${ADMIN}')`); // ₹1 = 2 tokens
      expect(sql(`select units, balance_units from token_adjust('${A}', 'credit', 50000, '${ADMIN}', 'Admin manual balance adjustment')`))
        .toBe("1000000|1000000"); // ₹500 → 1000 tokens
      expect(sqlError(`select token_adjust('${A}', 'credit', 100, '${ADMIN}', ' ')`)).toContain("reason_required");
      expect(sqlError(`select token_adjust('${A}', 'credit', 0, '${ADMIN}', 'x')`)).toContain("invalid_amount");
      expect(sqlError(`select token_adjust('${A}', 'refund', 100, '${ADMIN}', 'x')`)).toContain("invalid_kind");
      expect(sqlError(`select token_adjust('${A}', 'debit', 50001, '${ADMIN}', 'too much')`)).toContain("insufficient_balance");
      expect(sql(`select balance_units from token_adjust('${A}', 'debit', 10000, '${ADMIN}', 'correction')`)).toBe("800000");
      expect(sql(`select string_agg(entry_type || ':' || amount_units || ':' || rate_num || '/' || rate_den || ':' || reference, ',' order by created_at) from token_ledger where account_id='${A}'`))
        .toBe("grant:1000000:2/1:inr:50000,admin_deduct:-200000:2/1:inr:10000");
    });

    it("046: usage summary counts charged (not refunded) messages per account", () => {
      sql(`select token_grant('${A}', 5000, '${ADMIN}', 'test')`);
      reserve(A, "s1"); reserve(A, "s2"); reserve(A, "s3");
      sql(`select token_release_charge('s3', '400')`);
      sql(`update message_charges set created_at = now() - interval '40 days' where message_id = 's1'`);
      expect(sql(`select messages_since, messages_all from token_usage_summary(now() - interval '30 days') where account_id='${A}'`)).toBe("1|2");
    });

    it("the ledger is append-only and the balance can never be negative", () => {
      sql(`select token_grant('${A}', 1000, '${ADMIN}', 'test')`);
      expect(sqlError("update token_ledger set amount_units = 0")).toContain("append-only");
      expect(sqlError("delete from token_ledger")).toContain("append-only");
      expect(sqlError(`update token_wallets set balance_units = -1 where account_id='${A}'`)).toContain("check");
      // Deleting the account itself still cascades.
      sql(`delete from accounts where id='${B}'`);
      expect(sql(`select count(*) from token_ledger where account_id='${B}'`)).toBe("0");
    });
  });
});

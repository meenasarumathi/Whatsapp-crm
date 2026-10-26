// ============================================================
// Charging lifecycle for automated WhatsApp sends.
//
// Every automated sender wraps its provider call in `sendWithCharge`:
//
//   1. Feature switch (chatbot / workflow / ai_agent) off → throw
//      AutomatedSendBlockedError('feature_disabled'). Nothing sent,
//      nothing charged.
//      The platform owner's account (super admin) is
//      unlimited: the reserve answers 'unlimited' and the message is
//      sent with no charge at all.
//   2. token_reserve_charge — ONE transaction: lock the wallet row,
//      check balance ≥ 500 units, insert/reuse the message_charges row
//      (unique on the logical message key), write a -500 usage_reserve
//      ledger row. Anything but 'reserved' → AutomatedSendBlockedError
//      (insufficient_tokens, or the same message is already in flight /
//      sent / under review — so a retry never sends twice).
//   3. Call the provider AFTER that transaction committed.
//   4. Accepted → token_confirm_charge (0-unit audit row, status sent).
//      Rejected with a 4xx → token_release_charge (+500, status
//      released). Anything else (5xx, timeout, dropped connection,
//      unreadable 2xx) → token_mark_reconciliation: the 500 units stay
//      reserved and the message is NOT retried automatically.
//
// KNOWN LIMITATION: if Meta accepts a message but the response is lost,
// we can't tell. Meta's Cloud API has no endpoint to look up an
// outgoing message, and without the response there is no wamid to match
// against status webhooks. Such charges stay `needs_reconciliation`
// until the super admin resolves them (Token admin → Review queue).
// ============================================================

import { createServiceDb, type DbClient } from "@/lib/db";

import {
  SOURCE_FEATURE,
  classifyProviderFailure,
  type BlockReason,
  type ChargeSpec,
  type WalletFeature,
} from "./policy";
import { CHARGE_UNITS } from "./units";

/** Owner connection — the wallet tables and functions are closed to the app role. */
export function walletAdminClient(): DbClient {
  return createServiceDb();
}

/** An automated send that was deliberately not attempted. */
export class AutomatedSendBlockedError extends Error {
  readonly reason: BlockReason;
  constructor(reason: BlockReason) {
    super(reason);
    this.name = "AutomatedSendBlockedError";
    this.reason = reason;
  }
}

export function isBlockedSend(err: unknown): err is AutomatedSendBlockedError {
  return err instanceof AutomatedSendBlockedError;
}

/**
 * Codes meaning "the wallet section of db/schema.sql isn't applied":
 * function or table missing. Before the migration there are no wallets
 * to charge, so sends go ahead uncharged (with a warning) rather than
 * every automation in the CRM stopping the moment the code deploys.
 */
export function isWalletNotMigrated(err: { code?: string } | null | undefined): boolean {
  return !!err && ["PGRST202", "PGRST205", "42883", "42P01"].includes(err.code ?? "");
}

let warnedNotMigrated = false;
function warnNotMigrated() {
  if (warnedNotMigrated) return;
  warnedNotMigrated = true;
  console.warn(
    "[wallet] the token wallet tables are missing (run `npm run db:init`) — automated sends are NOT being metered.",
  );
}

/** Feature switch for one account. No row (or no table yet) = on. */
export async function isFeatureEnabled(
  db: DbClient,
  accountId: string,
  feature: WalletFeature,
): Promise<boolean> {
  const { data, error } = await db
    .from("account_feature_flags")
    .select("enabled")
    .eq("account_id", accountId)
    .eq("feature", feature)
    .maybeSingle();
  if (error) {
    if (isWalletNotMigrated(error)) {
      warnNotMigrated();
      return true;
    }
    // Fail closed: an unreadable switch must not let a paid send through.
    throw new Error(`feature switch lookup failed: ${error.message}`);
  }
  return data ? data.enabled !== false : true;
}

/**
 * Cheap, non-binding pre-check used before expensive work (e.g. calling
 * the LLM): is the feature on and is there at least one message's worth
 * of balance? The binding check is still the reserve in sendWithCharge.
 */
export async function preflightAutomatedSend(
  accountId: string,
  source: ChargeSpec["source"],
): Promise<BlockReason | null> {
  const db = walletAdminClient();
  const feature = SOURCE_FEATURE[source];
  if (feature && !(await isFeatureEnabled(db, accountId, feature))) return "feature_disabled";
  const status = await accountWalletStatus(db, accountId);
  if (!status) return null; // wallet not migrated yet
  if (status.unlimited) return null;
  return status.balanceUnits >= CHARGE_UNITS ? null : "insufficient_tokens";
}

/**
 * Balance + whether the account is the unlimited platform owner.
 * Falls back to a plain balance read on an older wallet schema.
 * Null when the wallet isn't set up at all.
 */
export async function accountWalletStatus(
  db: DbClient,
  accountId: string,
): Promise<{ unlimited: boolean; balanceUnits: number } | null> {
  const { data, error } = await db.rpc("token_account_status", { p_account_id: accountId });
  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as { unlimited?: boolean; balance_units?: number | string } | null;
    return { unlimited: !!row?.unlimited, balanceUnits: Number(row?.balance_units ?? 0) };
  }
  if (!isWalletNotMigrated(error)) throw new Error(`wallet status failed: ${error.message}`);
  const { data: w, error: wErr } = await db
    .from("token_wallets")
    .select("balance_units")
    .eq("account_id", accountId)
    .maybeSingle();
  if (wErr) {
    if (isWalletNotMigrated(wErr)) return null;
    throw new Error(`wallet lookup failed: ${wErr.message}`);
  }
  return { unlimited: false, balanceUnits: Number(w?.balance_units ?? 0) };
}

interface ReserveRow {
  outcome: string;
  charge_id: string | null;
  balance_units: number | string | null;
}

/**
 * Run `send` (which must return the provider message id) under the
 * charging lifecycle above. Rethrows the provider error after recording
 * the outcome, so callers keep their existing error handling.
 */
export async function sendWithCharge(args: {
  accountId: string;
  charge: ChargeSpec;
  send: () => Promise<string>;
  db?: DbClient;
}): Promise<string> {
  const db = args.db ?? walletAdminClient();
  const { accountId, charge } = args;

  const feature = SOURCE_FEATURE[charge.source];
  if (feature && !(await isFeatureEnabled(db, accountId, feature))) {
    throw new AutomatedSendBlockedError("feature_disabled");
  }

  const { data, error } = await db.rpc("token_reserve_charge", {
    p_account_id: accountId,
    p_message_id: charge.messageKey,
    p_source: charge.source,
  });
  if (error) {
    if (isWalletNotMigrated(error)) {
      warnNotMigrated();
      return args.send();
    }
    // Fail closed — never send something we couldn't meter.
    throw new Error(`token reserve failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as ReserveRow | null;
  // Platform owner (super admin's account): unlimited —
  // send without a reservation; nothing to confirm or refund.
  if (row?.outcome === "unlimited") return args.send();
  if (!row || row.outcome !== "reserved") {
    throw new AutomatedSendBlockedError((row?.outcome ?? "key_conflict") as BlockReason);
  }

  let providerMessageId: string;
  try {
    providerMessageId = await args.send();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const verdict = classifyProviderFailure(err);
    const { error: outcomeErr } =
      verdict === "not_sent"
        ? await db.rpc("token_release_charge", { p_message_id: charge.messageKey, p_detail: detail })
        : await db.rpc("token_mark_reconciliation", { p_message_id: charge.messageKey, p_detail: detail });
    if (outcomeErr) {
      // The charge stays 'reserved'; the reconciliation job escalates it.
      console.error(`[wallet] could not record ${verdict} for ${charge.messageKey}:`, outcomeErr.message);
    }
    throw err;
  }

  const { error: confirmErr } = await db.rpc("token_confirm_charge", {
    p_message_id: charge.messageKey,
    p_provider_message_id: providerMessageId,
  });
  if (confirmErr) {
    // The message WAS sent and the units are already deducted; only the
    // audit marker is missing. Don't fail the send — the reconciliation
    // job escalates the still-'reserved' charge for review.
    console.error(`[wallet] confirm failed for ${charge.messageKey}:`, confirmErr.message);
  }
  return providerMessageId;
}

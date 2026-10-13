// ============================================================
// GET /api/wallet — the caller's own account wallet.
//
// Any member gets the balance (for the "automated replies paused"
// banner). The account owner (customer, D8) also gets the rate, GPay
// instructions, their recharge requests, ledger history and usage.
// The account comes from the session, never from the request.
// ============================================================

import { NextResponse } from "next/server";

import { getWalletContext, walletErrorResponse } from "@/lib/wallet/server";
import { accountWalletStatus, walletAdminClient } from "@/lib/wallet/charge";
import { canWallet, isWalletAdmin } from "@/lib/wallet/policy";
import { CHARGE_UNITS } from "@/lib/wallet/units";

export async function GET() {
  try {
    const ctx = await getWalletContext();
    const db = walletAdminClient();

    const status = await accountWalletStatus(db, ctx.accountId);
    if (!status) {
      return NextResponse.json(
        { error: "The token wallet isn't set up yet.", code: "not_migrated" },
        { status: 503 },
      );
    }

    const balance = status.balanceUnits;
    const base = {
      balance_units: balance,
      // The platform owner's account (super admin) is never charged.
      unlimited: status.unlimited,
      paused: !status.unlimited && balance < CHARGE_UNITS,
      is_owner: canWallet(ctx, "view_own_wallet"),
      is_wallet_admin: isWalletAdmin(ctx.platformRole),
      is_super_admin: ctx.platformRole === "super_admin",
    };
    if (!base.is_owner) return NextResponse.json(base);

    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [settings, requests, ledger, usage, features] = await Promise.all([
      db.from("token_settings").select("rate_num, rate_den, gpay_upi_id, gpay_payee_name, gpay_instructions").eq("id", 1).maybeSingle(),
      db
        .from("recharge_requests")
        .select("id, amount_paise, tokens_units, rate_tokens_per_rupee_num, rate_tokens_per_rupee_den, status, payment_reference, decided_at, decision_note, created_at, proof_storage_key")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("token_ledger")
        .select("id, entry_type, amount_units, balance_after_units, reason, reference, created_at")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .limit(200),
      db
        .from("message_charges")
        .select("source, status")
        .eq("account_id", ctx.accountId)
        .gte("created_at", since)
        .limit(50_000),
      db.from("account_feature_flags").select("feature, enabled").eq("account_id", ctx.accountId),
    ]);
    for (const r of [settings, requests, ledger, usage, features]) if (r.error) throw r.error;

    const usageBySource: Record<string, number> = {};
    for (const row of usage.data ?? []) {
      if (row.status === "released") continue;
      usageBySource[row.source] = (usageBySource[row.source] ?? 0) + 1;
    }

    return NextResponse.json({
      ...base,
      settings: settings.data,
      requests: (requests.data ?? []).map(({ proof_storage_key, ...r }) => ({
        ...r,
        has_proof: !!proof_storage_key,
      })),
      ledger: ledger.data ?? [],
      usage_30d: usageBySource,
      features: features.data ?? [],
    });
  } catch (err) {
    return walletErrorResponse(err);
  }
}

// ============================================================
// /api/wallet/admin — Token admin (platform admins).
//
//   GET   overview: every account's balance, 30-day usage, feature
//         switches, the recharge queue, the review queue, settings.
//         admin + super_admin.
//   POST  { action, ... }:
//         decide        approve / reject a recharge     admin + super_admin
//         grant         add tokens with a reason        super_admin
//         deduct        remove tokens with a reason     super_admin
//         set_rate      tokens per rupee (num/den)      super_admin
//         set_gpay      GPay instructions               super_admin
//         set_feature   chatbot / workflow / ai_agent   super_admin
//         resolve       settle a needs_reconciliation   super_admin
//
// Every action is checked here on the server with `canWallet`.
// ============================================================

import { NextResponse } from "next/server";

import { ForbiddenError } from "@/lib/auth/account";
import {
  requireWallet,
  walletErrorResponse,
  walletRpcMessage,
  WalletInputError,
  type WalletContext,
} from "@/lib/wallet/server";
import { walletAdminClient } from "@/lib/wallet/charge";
import { canWallet, WALLET_FEATURES, type WalletAction, type WalletFeature } from "@/lib/wallet/policy";
import {
  CHARGE_UNITS,
  MAX_ADJUST_PAISE,
  parseRatePart,
  parseReason,
  parseRupeesToPaise,
  parseTokensToUnits,
} from "@/lib/wallet/units";
import { isUuid } from "@/lib/wallet/report";

const MAX_ACCOUNTS = 2000;

export async function GET() {
  try {
    const ctx = await requireWallet("view_all_accounts");
    const db = walletAdminClient();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const [accounts, wallets, owners, flags, usage, requests, review, settings, rates] = await Promise.all([
      db.from("accounts").select("id, name, owner_user_id, created_at").order("created_at").limit(MAX_ACCOUNTS),
      db.from("token_wallets").select("account_id, balance_units, updated_at").limit(MAX_ACCOUNTS),
      db.from("profiles").select("user_id, email, full_name").eq("account_role", "owner").limit(MAX_ACCOUNTS),
      db.from("account_feature_flags").select("account_id, feature, enabled").limit(MAX_ACCOUNTS * 3),
      db.rpc("token_usage_summary", { p_since: since }),
      db
        .from("recharge_requests")
        .select("id, account_id, amount_paise, tokens_units, rate_tokens_per_rupee_num, rate_tokens_per_rupee_den, status, payment_reference, proof_storage_key, decided_by, decided_at, decision_note, created_at")
        .order("created_at", { ascending: false })
        .limit(300),
      db
        .from("message_charges")
        .select("message_id, account_id, source, status, detail, created_at, updated_at")
        .eq("status", "needs_reconciliation")
        .order("updated_at", { ascending: true })
        .limit(300),
      db.from("token_settings").select("*").eq("id", 1).maybeSingle(),
      db.from("token_rate_changes").select("rate_num, rate_den, changed_by, created_at").order("created_at", { ascending: false }).limit(20),
    ]);
    for (const r of [accounts, wallets, owners, flags, usage, requests, review, settings, rates]) {
      if (r.error) throw r.error;
    }

    const balance = new Map((wallets.data ?? []).map((w) => [w.account_id, Number(w.balance_units)]));
    const owner = new Map((owners.data ?? []).map((p) => [p.user_id, p]));
    // Messages charged and not refunded: last 30 days and all time.
    const used = new Map<string, number>();
    const usedAllTime = new Map<string, number>();
    for (const u of (usage.data ?? []) as { account_id: string; messages_since: number; messages_all: number }[]) {
      used.set(u.account_id, Number(u.messages_since));
      usedAllTime.set(u.account_id, Number(u.messages_all));
    }
    // Which accounts belong to a platform super admin (unlimited, 046).
    const superAdmins = new Set<string>();
    const { data: supers, error: supersErr } = await db
      .from("platform_users")
      .select("user_id")
      .eq("platform_role", "super_admin");
    if (!supersErr) for (const s of supers ?? []) superAdmins.add(s.user_id as string);
    const featureMap = new Map<string, Record<WalletFeature, boolean>>();
    for (const f of flags.data ?? []) {
      const cur = featureMap.get(f.account_id) ?? { chatbot: true, workflow: true, ai_agent: true };
      cur[f.feature as WalletFeature] = f.enabled;
      featureMap.set(f.account_id, cur);
    }
    const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));

    return NextResponse.json({
      me: { role: ctx.platformRole, account_id: ctx.accountId },
      accounts: (accounts.data ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        owner_email: owner.get(a.owner_user_id)?.email ?? null,
        unlimited: superAdmins.has(a.owner_user_id),
        balance_units: balance.get(a.id) ?? 0,
        messages_30d: used.get(a.id) ?? 0,
        spent_units: (usedAllTime.get(a.id) ?? 0) * CHARGE_UNITS,
        features: featureMap.get(a.id) ?? { chatbot: true, workflow: true, ai_agent: true },
      })),
      requests: (requests.data ?? []).map(({ proof_storage_key, ...r }) => ({
        ...r,
        account_name: accountName.get(r.account_id) ?? null,
        has_proof: !!proof_storage_key,
      })),
      review_queue: (review.data ?? []).map((c) => ({ ...c, account_name: accountName.get(c.account_id) ?? null })),
      settings: settings.data,
      rate_history: rates.data ?? [],
    });
  } catch (err) {
    return walletErrorResponse(err);
  }
}

const ACTION_PERMISSION: Record<string, WalletAction> = {
  decide: "decide_recharge",
  grant: "grant",
  deduct: "deduct",
  // Adjust Wallet dialog: credit needs grant, debit needs deduct — both super admin.
  adjust: "grant",
  set_rate: "change_rate",
  set_gpay: "change_rate",
  set_feature: "change_features",
  resolve: "resolve_reconciliation",
};

function str(v: unknown, max: number): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new WalletInputError("Invalid text field.");
  const s = v.trim();
  if (s.length > max) throw new WalletInputError(`Keep it under ${max} characters.`);
  return s || null;
}

export async function POST(request: Request) {
  try {
    // Authorise first: a non-admin gets 403 whatever they send.
    const ctx: WalletContext = await requireWallet("view_all_accounts");
    const body = await request.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "";
    const permission = ACTION_PERMISSION[action];
    if (!permission) throw new WalletInputError("Unknown action.");
    if (!canWallet(ctx, permission)) {
      throw new ForbiddenError("Only the Super admin can do this.");
    }

    const db = walletAdminClient();
    const rpcFail = (message: string) => {
      const friendly = walletRpcMessage(message);
      if (friendly) throw new WalletInputError(friendly);
      throw new Error(message);
    };

    switch (action) {
      case "decide": {
        if (!isUuid(body.request_id)) throw new WalletInputError("request_id must be a UUID.");
        if (typeof body.approve !== "boolean") throw new WalletInputError("approve must be true or false.");
        const note = str(body.note, 500);
        if (!body.approve && !note) throw new WalletInputError("A note is required to reject a request.");
        const { data, error } = await db.rpc("token_decide_recharge", {
          p_request_id: body.request_id,
          p_actor: ctx.userId,
          p_approve: body.approve,
          p_note: note,
        });
        if (error) rpcFail(error.message);
        if (data === "not_found") return NextResponse.json({ error: "Request not found." }, { status: 404 });
        if (data === "already_decided") {
          return NextResponse.json({ error: "This request was already decided.", outcome: data }, { status: 409 });
        }
        return NextResponse.json({ outcome: data });
      }

      case "grant":
      case "deduct": {
        if (!isUuid(body.account_id)) throw new WalletInputError("account_id must be a UUID.");
        const units = parseTokensToUnits(body.tokens);
        if (!units.ok) throw new WalletInputError(units.error);
        const reason = parseReason(body.reason);
        if (!reason.ok) throw new WalletInputError(reason.error);
        const { data, error } = await db.rpc(action === "grant" ? "token_grant" : "token_deduct", {
          p_account_id: body.account_id,
          p_units: units.value,
          p_actor: ctx.userId,
          p_reason: reason.value,
        });
        if (error) rpcFail(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        return NextResponse.json({ balance_units: Number(row?.balance_units ?? 0) });
      }

      case "adjust": {
        if (!isUuid(body.account_id)) throw new WalletInputError("account_id must be a UUID.");
        if (body.kind !== "credit" && body.kind !== "debit") {
          throw new WalletInputError("kind must be 'credit' or 'debit'.");
        }
        if (body.kind === "debit" && !canWallet(ctx, "deduct")) {
          throw new ForbiddenError("Only the Super admin can do this.");
        }
        const paise = parseRupeesToPaise(body.amount_rupees, MAX_ADJUST_PAISE);
        if (!paise.ok) throw new WalletInputError(paise.error);
        const reason = parseReason(body.reason);
        if (!reason.ok) throw new WalletInputError(reason.error);
        const { data, error } = await db.rpc("token_adjust", {
          p_account_id: body.account_id,
          p_kind: body.kind,
          p_amount_paise: paise.value,
          p_actor: ctx.userId,
          p_reason: reason.value,
        });
        if (error) rpcFail(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        return NextResponse.json({
          units: Number(row?.units ?? 0),
          balance_units: Number(row?.balance_units ?? 0),
        });
      }

      case "set_rate": {
        const num = parseRatePart(body.rate_num);
        const den = parseRatePart(body.rate_den);
        if (!num.ok) throw new WalletInputError(`Tokens: ${num.error}`);
        if (!den.ok) throw new WalletInputError(`Rupees: ${den.error}`);
        const { error } = await db.rpc("token_set_rate", {
          p_rate_num: num.value,
          p_rate_den: den.value,
          p_actor: ctx.userId,
        });
        if (error) rpcFail(error.message);
        return NextResponse.json({ ok: true });
      }

      case "set_gpay": {
        const { error } = await db
          .from("token_settings")
          .update({
            gpay_upi_id: str(body.gpay_upi_id, 100),
            gpay_payee_name: str(body.gpay_payee_name, 100),
            gpay_instructions: str(body.gpay_instructions, 2000),
            updated_by: ctx.userId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", 1);
        if (error) throw error;
        return NextResponse.json({ ok: true });
      }

      case "set_feature": {
        if (!isUuid(body.account_id)) throw new WalletInputError("account_id must be a UUID.");
        if (!(WALLET_FEATURES as readonly string[]).includes(body.feature)) {
          throw new WalletInputError("feature must be chatbot, workflow or ai_agent.");
        }
        if (typeof body.enabled !== "boolean") throw new WalletInputError("enabled must be true or false.");
        const { error } = await db.from("account_feature_flags").upsert(
          {
            account_id: body.account_id,
            feature: body.feature,
            enabled: body.enabled,
            updated_by: ctx.userId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "account_id,feature" },
        );
        if (error) throw error;
        return NextResponse.json({ ok: true });
      }

      case "resolve": {
        const messageId = str(body.message_id, 200);
        if (!messageId) throw new WalletInputError("message_id is required.");
        if (body.outcome !== "sent" && body.outcome !== "released") {
          throw new WalletInputError("outcome must be 'sent' or 'released'.");
        }
        const reason = parseReason(body.reason);
        if (!reason.ok) throw new WalletInputError(reason.error);
        const { data, error } =
          body.outcome === "sent"
            ? await db.rpc("token_confirm_charge", {
                p_message_id: messageId,
                p_provider_message_id: str(body.provider_message_id, 200),
                p_actor: ctx.userId,
                p_reason: reason.value,
              })
            : await db.rpc("token_release_charge", {
                p_message_id: messageId,
                p_detail: reason.value,
                p_actor: ctx.userId,
              });
        if (error) rpcFail(error.message);
        if (data === "not_found") return NextResponse.json({ error: "Charge not found." }, { status: 404 });
        if (data === "invalid_state") {
          return NextResponse.json({ error: "This charge is no longer under review." }, { status: 409 });
        }
        return NextResponse.json({ outcome: data });
      }
    }
    throw new WalletInputError("Unknown action.");
  } catch (err) {
    return walletErrorResponse(err);
  }
}

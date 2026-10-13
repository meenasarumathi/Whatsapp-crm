// ============================================================
// Token wallet — who may do what, and how sends are classified. Pure.
//
// Role mapping (docs/token-wallet/PLAN.md §4):
//   super_admin → platform_users.platform_role = 'super_admin'
//   admin       → platform_role 'admin1' or 'admin2'
//   customer    → account owner (profiles.account_role = 'owner')
// Every API route calls these on the server; the UI only mirrors them.
// ============================================================

import type { AccountRole } from "@/lib/auth/roles";
import type { PlatformRole } from "@/lib/platform/access";

export interface WalletActor {
  platformRole: PlatformRole | null;
  accountRole: AccountRole | null;
}

export type WalletAction =
  | "view_own_wallet"
  | "submit_recharge"
  | "view_all_accounts"
  | "view_reports"
  | "decide_recharge"
  | "view_proof"
  | "grant"
  | "deduct"
  | "change_rate"
  | "change_features"
  | "resolve_reconciliation";

export function isWalletAdmin(role: PlatformRole | null): boolean {
  return role === "super_admin" || role === "admin1" || role === "admin2";
}

export function canWallet(actor: WalletActor, action: WalletAction): boolean {
  switch (action) {
    case "view_own_wallet":
    case "submit_recharge":
      return actor.accountRole === "owner";
    case "view_all_accounts":
    case "view_reports":
    case "decide_recharge":
    case "view_proof":
      return isWalletAdmin(actor.platformRole);
    case "grant":
    case "deduct":
    case "change_rate":
    case "change_features":
    case "resolve_reconciliation":
      return actor.platformRole === "super_admin";
  }
}

// ------------------------------------------------------------
// Charged send sources
// ------------------------------------------------------------

export type ChargeSource = "ai_agent" | "chatbot" | "workflow" | "broadcast" | "api";
export type WalletFeature = "chatbot" | "workflow" | "ai_agent";
export const WALLET_FEATURES: readonly WalletFeature[] = ["chatbot", "workflow", "ai_agent"] as const;

/** Which feature switch gates each source; broadcasts and API sends have none (D9). */
export const SOURCE_FEATURE: Record<ChargeSource, WalletFeature | null> = {
  ai_agent: "ai_agent",
  chatbot: "chatbot",
  workflow: "workflow",
  broadcast: null,
  api: null,
};

/**
 * Public-API sends (POST /api/v1/messages) are charged as automated:
 * no human is typing them in the inbox. Set to false to make them free.
 */
export const CHARGE_PUBLIC_API_SENDS = true;

/** What a charge identifies: the source and a logical message key (PLAN.md §3). */
export interface ChargeSpec {
  source: ChargeSource;
  messageKey: string;
}

export type BlockReason =
  | "insufficient_tokens"
  | "feature_disabled"
  | "in_flight"
  | "already_sent"
  | "needs_reconciliation"
  | "key_conflict";

/** User-facing text for a blocked automated send. */
export const INSUFFICIENT_TOKENS_MESSAGE =
  "Insufficient tokens. Automated replies are paused. Manual replies are still available.";

/**
 * After a failed provider call: was the message definitely NOT sent
 * (safe to refund), or is the outcome unknown (keep reserved, review)?
 *
 * Meta answers a rejected send with a 4xx and an error body — nothing
 * was delivered. A 5xx, a dropped connection, a timeout, or a 2xx we
 * couldn't parse may have been accepted, so those are ambiguous. When
 * in doubt this says "ambiguous": refunding a message that was in fact
 * sent is the one mistake we never want to make.
 */
export function classifyProviderFailure(err: unknown): "not_sent" | "ambiguous" {
  const status =
    err && typeof err === "object" && "httpStatus" in err
      ? (err as { httpStatus: unknown }).httpStatus
      : null;
  if (typeof status === "number" && status >= 400 && status < 500) return "not_sent";
  return "ambiguous";
}

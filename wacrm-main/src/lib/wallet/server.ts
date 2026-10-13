// ============================================================
// Server-side caller context for the /api/wallet routes.
//
// The account ALWAYS comes from the session (getCurrentAccount), never
// from request input. Permission checks go through `canWallet`.
// Server-only: imports the SSR Supabase client.
// ============================================================

import { NextResponse } from "next/server";

import { ForbiddenError, getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { PlatformNotMigratedError, loadPlatformUser } from "@/lib/platform/server";
import type { PlatformRole } from "@/lib/platform/access";
import { canWallet, type WalletAction, type WalletActor } from "./policy";
import { isWalletNotMigrated } from "./charge";

export interface WalletContext extends WalletActor {
  userId: string;
  accountId: string;
  accountName: string;
}

export async function getWalletContext(): Promise<WalletContext> {
  const ctx = await getCurrentAccount();
  let platformRole: PlatformRole | null = null;
  try {
    platformRole = (await loadPlatformUser(ctx.userId)).platform_role;
  } catch (err) {
    // Before migration 043 nobody is a platform admin.
    if (!(err instanceof PlatformNotMigratedError)) throw err;
  }
  return {
    userId: ctx.userId,
    accountId: ctx.accountId,
    accountName: ctx.account.name,
    accountRole: ctx.role,
    platformRole,
  };
}

/** Resolve the caller and require `action`, or throw ForbiddenError. */
export async function requireWallet(action: WalletAction): Promise<WalletContext> {
  const ctx = await getWalletContext();
  if (!canWallet(ctx, action)) {
    throw new ForbiddenError("You don't have permission to do this.");
  }
  return ctx;
}

/** Thrown for bad input; maps to 400. */
export class WalletInputError extends Error {
  readonly status = 400 as const;
}

export function walletErrorResponse(err: unknown): NextResponse {
  if (err instanceof WalletInputError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err && typeof err === "object" && "code" in err && isWalletNotMigrated(err as { code?: string })) {
    return NextResponse.json(
      {
        error:
          "The token wallet isn't set up yet. Run supabase/migrations/045_token_wallet.sql in the Supabase SQL editor.",
        code: "not_migrated",
      },
      { status: 503 },
    );
  }
  return toErrorResponse(err);
}

/** Map a P0001 RAISE from the wallet functions to a friendly 400. */
export function walletRpcMessage(message: string): string | null {
  if (message.includes("insufficient_balance")) return "That would take the balance below zero.";
  if (message.includes("reason_required")) return "A reason is required.";
  if (message.includes("note_required")) return "A note is required to reject a request.";
  if (message.includes("invalid_amount")) return "Enter a valid amount.";
  if (message.includes("invalid_rate")) return "Enter a valid rate.";
  if (message.includes("invalid_kind")) return "Choose credit or debit.";
  return null;
}

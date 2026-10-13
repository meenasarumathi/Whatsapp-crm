// ============================================================
// GET /api/wallet/admin/proof/[id] — short-lived link to a recharge
// proof. Platform admins can open any proof; an account owner only
// their own account's. Everyone else gets 404 (no hint that it exists).
// ============================================================

import { NextResponse } from "next/server";

import { getWalletContext, walletErrorResponse } from "@/lib/wallet/server";
import { walletAdminClient } from "@/lib/wallet/charge";
import { canWallet } from "@/lib/wallet/policy";
import { PROOF_BUCKET } from "@/lib/wallet/units";
import { isUuid } from "@/lib/wallet/report";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getWalletContext();
    const notFound = NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!isUuid(id)) return notFound;

    const db = walletAdminClient();
    const { data: req, error } = await db
      .from("recharge_requests")
      .select("account_id, proof_storage_key")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!req?.proof_storage_key) return notFound;

    const allowed =
      canWallet(ctx, "view_proof") ||
      (canWallet(ctx, "view_own_wallet") && req.account_id === ctx.accountId);
    if (!allowed) return notFound;

    const { data: signed, error: signErr } = await db.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(req.proof_storage_key, 60);
    if (signErr || !signed) throw signErr ?? new Error("could not sign proof url");
    return NextResponse.json({ url: signed.signedUrl, expires_in: 60 });
  } catch (err) {
    return walletErrorResponse(err);
  }
}

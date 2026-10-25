// ============================================================
// GET /api/wallet/admin/proof/[id] — a recharge proof. Platform admins
// can open any proof; an account owner only their own account's.
// Everyone else gets 404 (no hint that it exists).
//
//   no query      → { url } pointing back here with ?download=1
//   ?download=1   → the file itself (permission checked again)
// ============================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";

import { getWalletContext, walletErrorResponse } from "@/lib/wallet/server";
import { walletAdminClient } from "@/lib/wallet/charge";
import { canWallet } from "@/lib/wallet/policy";
import { readProof } from "@/lib/wallet/proof-store";
import { isUuid } from "@/lib/wallet/report";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    if (new URL(request.url).searchParams.get("download") !== "1") {
      return NextResponse.json({ url: `/api/wallet/admin/proof/${id}?download=1` });
    }
    const file = await readProof(req.proof_storage_key);
    if (!file) return notFound;
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.data.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
      },
    });
  } catch (err) {
    return walletErrorResponse(err);
  }
}

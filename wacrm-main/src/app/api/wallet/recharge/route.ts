// ============================================================
// POST /api/wallet/recharge — account owner submits a GPay recharge.
//
// multipart/form-data: amount_rupees (required), payment_reference
// (optional, ≤100 chars), proof (optional PNG / JPG / PDF, ≤5 MB).
// The proof goes to the PRIVATE `recharge-proofs` bucket under
// <account_id>/<uuid>.<ext>; it's never publicly reachable and its
// contents are never logged. The request is only a claim — tokens are
// credited when an admin approves it (D7).
// ============================================================

import { NextResponse } from "next/server";

import { requireWallet, walletErrorResponse, WalletInputError } from "@/lib/wallet/server";
import { walletAdminClient } from "@/lib/wallet/charge";
import {
  PROOF_BUCKET,
  parsePaymentReference,
  parseRupeesToPaise,
  sniffProof,
  validateProof,
} from "@/lib/wallet/units";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const RECHARGE_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };

export async function POST(request: Request) {
  try {
    const ctx = await requireWallet("submit_recharge");

    const limit = checkRateLimit(`recharge:${ctx.userId}`, RECHARGE_RATE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const form = await request.formData().catch(() => null);
    if (!form) throw new WalletInputError("Send the form as multipart/form-data.");

    const amount = parseRupeesToPaise(form.get("amount_rupees"));
    if (!amount.ok) throw new WalletInputError(amount.error);
    const ref = parsePaymentReference(form.get("payment_reference"));
    if (!ref.ok) throw new WalletInputError(ref.error);

    const db = walletAdminClient();
    let proofKey: string | null = null;
    const proof = form.get("proof");
    if (proof instanceof File && proof.size > 0) {
      const check = validateProof(proof);
      if (!check.ok) throw new WalletInputError(check.error);
      const bytes = new Uint8Array(await proof.arrayBuffer());
      if (!sniffProof(bytes, proof.type)) {
        throw new WalletInputError("The file doesn't look like a real PNG, JPG or PDF.");
      }
      proofKey = `${ctx.accountId}/${crypto.randomUUID()}.${check.value}`;
      const { error: upErr } = await db.storage
        .from(PROOF_BUCKET)
        .upload(proofKey, bytes, { contentType: proof.type, upsert: false });
      if (upErr) {
        console.error("[wallet/recharge] proof upload failed:", upErr.message);
        return NextResponse.json({ error: "Couldn't store the proof file. Try again." }, { status: 500 });
      }
    }

    const { data, error } = await db.rpc("token_submit_recharge", {
      p_account_id: ctx.accountId,
      p_user_id: ctx.userId,
      p_amount_paise: amount.value,
      p_payment_reference: ref.value,
      p_proof_storage_key: proofKey,
    });
    if (error) {
      if (proofKey) await db.storage.from(PROOF_BUCKET).remove([proofKey]);
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json(
      {
        id: row.id,
        status: row.status,
        amount_paise: row.amount_paise,
        tokens_units: row.tokens_units,
      },
      { status: 201 },
    );
  } catch (err) {
    return walletErrorResponse(err);
  }
}

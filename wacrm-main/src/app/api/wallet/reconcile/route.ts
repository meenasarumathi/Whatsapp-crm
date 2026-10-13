// ============================================================
// GET /api/wallet/reconcile — reconciliation job (cron).
//
// Auth: same `x-cron-secret: $AUTOMATION_CRON_SECRET` header as the
// automations / flows crons. Escalates charges stuck in 'reserved' for
// over 10 minutes (the process died between reserve and outcome) to
// 'needs_reconciliation'.
//
// It cannot settle them on its own: Meta's Cloud API has no lookup for
// an outgoing message, and a lost response leaves no wamid to match
// against status webhooks. Escalated charges wait in the super admin's
// review queue (Settings → Token admin), units still reserved, and are
// never resent automatically.
// ============================================================

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

import { walletAdminClient } from "@/lib/wallet/charge";

const STALE_SECONDS = 10 * 60;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "AUTOMATION_CRON_SECRET is not set" }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get("x-cron-secret") ?? "");
  const want = Buffer.from(expected);
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = walletAdminClient();
  const { data, error } = await db.rpc("token_escalate_stale_charges", {
    p_older_than_seconds: STALE_SECONDS,
  });
  if (error) {
    console.error("[wallet/reconcile] escalate failed:", error.message);
    return NextResponse.json({ error: "reconcile failed" }, { status: 500 });
  }
  const { count } = await db
    .from("message_charges")
    .select("id", { count: "exact", head: true })
    .eq("status", "needs_reconciliation");
  return NextResponse.json({ escalated: data ?? 0, awaiting_review: count ?? 0 });
}

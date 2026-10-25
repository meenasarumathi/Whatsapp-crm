// ============================================================
// GET /api/wallet/admin/ledger — transaction report (admin + super_admin)
//   ?account_id=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD&type=grant,usage_reserve
//   &format=csv  → file download
// ============================================================

import { NextResponse } from "next/server";
import type { Row } from "@/lib/db";

import { requireWallet, walletErrorResponse, WalletInputError } from "@/lib/wallet/server";
import { walletAdminClient } from "@/lib/wallet/charge";
import { dateBounds, ledgerToCsv, parseLedgerFilters, type LedgerFilters } from "@/lib/wallet/report";

const MAX_ROWS = 50_000;
const PAGE = 1000;

export async function GET(request: Request) {
  try {
    await requireWallet("view_reports");
    const url = new URL(request.url);
    let filters: LedgerFilters;
    try {
      filters = parseLedgerFilters(url.searchParams);
    } catch (e) {
      throw new WalletInputError(e instanceof Error ? e.message : "Invalid filters.");
    }
    const db = walletAdminClient();
    const bounds = dateBounds(filters);

    const rows: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      let q = db
        .from("token_ledger")
        .select("id, created_at, account_id, entry_type, amount_units, balance_after_units, reason, reference, actor_user_id")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (filters.accountId) q = q.eq("account_id", filters.accountId);
      if (filters.types.length) q = q.in("entry_type", filters.types);
      if (bounds.gte) q = q.gte("created_at", bounds.gte);
      if (bounds.lt) q = q.lt("created_at", bounds.lt);
      const { data, error } = await q;
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }

    const { data: accounts } = await db.from("accounts").select("id, name").limit(5000);
    const name = new Map((accounts ?? []).map((a: Row) => [a.id, a.name]));
    const enriched = rows.map((r) => ({ ...r, account_name: name.get(r.account_id as string) ?? null }));

    // Totals by type for the report header.
    const totals: Record<string, number> = {};
    for (const r of rows) totals[r.entry_type as string] = (totals[r.entry_type as string] ?? 0) + Number(r.amount_units);

    if (url.searchParams.get("format") === "csv") {
      const stamp = new Date().toISOString().slice(0, 10);
      return new NextResponse(ledgerToCsv(enriched as never), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="token-ledger-${stamp}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ rows: enriched.slice(0, 500), total_rows: rows.length, totals });
  } catch (err) {
    return walletErrorResponse(err);
  }
}

// ============================================================
// Token wallet reports — filter parsing and CSV. Pure.
// ============================================================

export const LEDGER_ENTRY_TYPES = [
  "grant",
  "recharge_credit",
  "usage_reserve",
  "usage_confirm",
  "usage_release",
  "admin_deduct",
  "reversal",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface LedgerFilters {
  accountId: string | null;
  from: string | null;
  to: string | null;
  types: LedgerEntryType[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Parse ?account_id=&from=YYYY-MM-DD&to=YYYY-MM-DD&type=a,b. Throws on bad input. */
export function parseLedgerFilters(params: URLSearchParams): LedgerFilters {
  const accountId = params.get("account_id") || null;
  if (accountId && !isUuid(accountId)) throw new Error("account_id must be a UUID");
  const from = params.get("from") || null;
  const to = params.get("to") || null;
  for (const d of [from, to]) {
    if (d && (!DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) {
      throw new Error("Dates must be YYYY-MM-DD");
    }
  }
  if (from && to && from > to) throw new Error("'from' must be on or before 'to'");
  const rawTypes = (params.get("type") || "").split(",").map((t) => t.trim()).filter(Boolean);
  const types = rawTypes.filter((t): t is LedgerEntryType =>
    (LEDGER_ENTRY_TYPES as readonly string[]).includes(t),
  );
  if (types.length !== rawTypes.length) throw new Error("Unknown transaction type");
  return { accountId, from, to, types };
}

/** Inclusive date range → ISO bounds for created_at (UTC days). */
export function dateBounds(f: Pick<LedgerFilters, "from" | "to">): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  if (f.from) out.gte = `${f.from}T00:00:00.000Z`;
  if (f.to) {
    const end = new Date(`${f.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    out.lt = end.toISOString();
  }
  return out;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface LedgerCsvRow {
  created_at: string;
  account_id: string;
  account_name?: string | null;
  entry_type: string;
  amount_units: number | string;
  balance_after_units: number | string;
  reason?: string | null;
  reference?: string | null;
  actor_user_id?: string | null;
}

export function ledgerToCsv(rows: LedgerCsvRow[]): string {
  const header = [
    "created_at", "account_id", "account_name", "entry_type",
    "amount_units", "amount_tokens", "balance_after_units", "balance_after_tokens",
    "reason", "reference", "actor_user_id",
  ];
  const lines = rows.map((r) =>
    [
      r.created_at, r.account_id, r.account_name ?? "", r.entry_type,
      r.amount_units, Number(r.amount_units) / 1000,
      r.balance_after_units, Number(r.balance_after_units) / 1000,
      r.reason ?? "", r.reference ?? "", r.actor_user_id ?? "",
    ].map(csvCell).join(","),
  );
  return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}

"use client";

/**
 * Wallet → platform view (Super admin, Admin 1, Admin 2).
 *
 *   - Platform Owner Account banner: the super admin's own account is
 *     unlimited — never charged, no recharge needed.
 *   - Tenant Companies table: every non-owner company with its wallet
 *     balance and total spent in ₹ (converted at the current rate),
 *     plus "Adjust Wallet" (super admin only) for manual credits / debits.
 *   - Quick stats so the owner sees at a glance who is about to stop
 *     automating (₹0 balances) and what is waiting for approval.
 *
 * All amounts are converted from integer token units with the stored
 * rate; the server re-validates and converts again inside the database.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  Clock,
  Loader2,
  MessageSquare,
  Search,
  ShieldCheck,
  Wallet as WalletIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  formatRupeesExact,
  formatTokens,
  paiseForUnits,
  type Rate,
} from "@/lib/wallet/units";
import { AdjustWalletDialog, type AdjustTarget } from "./adjust-wallet-dialog";

interface AccountRow {
  id: string;
  name: string;
  owner_email: string | null;
  unlimited?: boolean;
  balance_units: number;
  spent_units?: number;
  messages_30d: number;
}

interface Overview {
  me: { role: string | null; account_id?: string };
  accounts: AccountRow[];
  requests: { status: string }[];
  review_queue: unknown[];
  settings: { rate_num: number; rate_den: number } | null;
}

/** Below this a tenant's balance shows amber (≈ 200 automated messages at ₹1/token). */
const LOW_BALANCE_PAISE = 100_00;

export function PlatformWalletAdmin() {
  const t = useTranslations("Wallet.platform");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<AdjustTarget | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/wallet/admin", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("loadFailed"));
      setData(json as Overview);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    }
  }, [t]);

  useEffect(() => {
     
    void load();
  }, [load]);

  const rate: Rate = { num: data?.settings?.rate_num ?? 1, den: data?.settings?.rate_den ?? 1 };
  const isSuper = data?.me.role === "super_admin";

  const tenants = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.accounts ?? [])
      .filter((a) => !a.unlimited)
      .filter((a) => !q || `${a.name} ${a.owner_email ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, query]);

  const stats = useMemo(() => {
    const all = (data?.accounts ?? []).filter((a) => !a.unlimited);
    return {
      totalBalancePaise: all.reduce((s, a) => s + paiseForUnits(a.balance_units, rate), 0),
      empty: all.filter((a) => a.balance_units < 500).length,
      pending: (data?.requests ?? []).filter((r) => r.status === "pending").length,
      messages30d: all.reduce((s, a) => s + a.messages_30d, 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {isSuper && (
        <section className="flex flex-col gap-4 rounded-2xl border border-violet-500/25 bg-gradient-to-r from-violet-500/10 via-card to-emerald-500/10 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold text-foreground">
              <ShieldCheck className="h-5 w-5 text-violet-500" />
              {t("ownerTitle")}
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {t.rich("ownerBody", { b: (chunks) => <strong className="text-foreground">{chunks}</strong> })}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-sm font-semibold text-violet-600 dark:text-violet-300 sm:self-center">
            <ShieldCheck className="h-4 w-4" />
            {t("unlimitedPill")}
          </span>
        </section>
      )}

      {error && (
        <div className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={<WalletIcon className="h-4 w-4" />} label={t("statBalance")} value={formatRupeesExact(stats.totalBalancePaise)} />
          <Stat
            icon={<AlertTriangle className="h-4 w-4" />}
            label={t("statEmpty")}
            value={String(stats.empty)}
            tone={stats.empty > 0 ? "red" : undefined}
          />
          <Link href="/settings?tab=tokens" className="block">
            <Stat
              icon={<Clock className="h-4 w-4" />}
              label={t("statPending")}
              value={String(stats.pending)}
              tone={stats.pending > 0 ? "amber" : undefined}
              hint={t("openQueue")}
            />
          </Link>
          <Stat icon={<MessageSquare className="h-4 w-4" />} label={t("statMessages")} value={stats.messages30d.toLocaleString("en-IN")} />
        </div>
      )}

      <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Building2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div>
              <h2 className="text-lg font-bold text-foreground">{t("tableTitle")}</h2>
              <p className="text-sm text-muted-foreground">{t("tableSubtitle")}</p>
            </div>
          </div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} className="pl-8" />
          </div>
        </div>

        <div className="mt-5 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-5 py-3.5 font-medium">{t("colCompany")}</th>
                <th className="px-5 py-3.5 font-medium">{t("colEmail")}</th>
                <th className="px-5 py-3.5 text-right font-medium">{t("colBalance")}</th>
                <th className="px-5 py-3.5 text-right font-medium">{t("colSpent")}</th>
                <th className="px-5 py-3.5 text-right font-medium">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {!data && !error ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              ) : tenants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                    {t("empty")}
                  </td>
                </tr>
              ) : (
                tenants.map((a) => {
                  const balancePaise = paiseForUnits(a.balance_units, rate);
                  const spentPaise = paiseForUnits(a.spent_units ?? 0, rate);
                  return (
                    <tr key={a.id} className="border-t border-border">
                      <td className="px-5 py-4 font-semibold text-foreground">{a.name}</td>
                      <td className="px-5 py-4 text-muted-foreground">{a.owner_email ?? "—"}</td>
                      <td
                        className={cn(
                          "px-5 py-4 text-right font-semibold tabular-nums",
                          a.balance_units < 500
                            ? "text-red-600 dark:text-red-400"
                            : balancePaise < LOW_BALANCE_PAISE
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-emerald-600 dark:text-emerald-400",
                        )}
                        title={`${formatTokens(a.balance_units)} tokens`}
                      >
                        {formatRupeesExact(balancePaise)}
                      </td>
                      <td className="px-5 py-4 text-right tabular-nums text-muted-foreground" title={`${formatTokens(a.spent_units ?? 0)} tokens`}>
                        {formatRupeesExact(spentPaise)}
                      </td>
                      <td className="px-5 py-4 text-right">
                        {isSuper ? (
                          <button
                            type="button"
                            onClick={() =>
                              setTarget({ id: a.id, name: a.name, email: a.owner_email, balanceUnits: a.balance_units })
                            }
                            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-800 to-emerald-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
                          >
                            <WalletIcon className="h-4 w-4" />
                            {t("adjust")}
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("superOnly")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("rateNote", { tokens: formatTokens(rate.num * 1000 / rate.den) })}</p>
      </section>

      <AdjustWalletDialog
        target={target}
        rate={rate}
        onClose={() => setTarget(null)}
        onDone={async (msg) => {
          toast.success(msg);
          setTarget(null);
          await load();
        }}
      />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "red" | "amber";
  hint?: string;
}) {
  return (
    <div className="h-full rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums text-foreground",
          tone === "red" && "text-red-600 dark:text-red-400",
          tone === "amber" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-primary">{hint} →</p>}
    </div>
  );
}

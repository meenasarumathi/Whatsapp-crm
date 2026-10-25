"use client";

/**
 * "Adjust Wallet Balance" — super admin manual credit / debit in ₹.
 * Quick-select amounts, a free amount, and a required reason. The
 * server converts ₹ → tokens at the current rate inside the database
 * and records it on the ledger (POST /api/wallet/admin, action adjust).
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Minus, Plus, Wallet as WalletIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MAX_ADJUST_PAISE,
  formatRupeesExact,
  formatTokens,
  paiseForUnits,
  parseRupeesToPaise,
  unitsForPaise,
  type Rate,
} from "@/lib/wallet/units";

export interface AdjustTarget {
  id: string;
  name: string;
  email: string | null;
  balanceUnits: number;
}

const QUICK_AMOUNTS = [100, 500, 1000, 2500, 5000];

export function AdjustWalletDialog({
  target,
  rate,
  onClose,
  onDone,
}: {
  target: AdjustTarget | null;
  rate: Rate;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const t = useTranslations("Wallet.adjust");
  const [kind, setKind] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("500");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form for every company.
  useEffect(() => {
    if (!target) return;
     
    setKind("credit");
    setAmount("500");
    setReason(t("defaultReason"));
    setError(null);
  }, [target, t]);

  const parsed = parseRupeesToPaise(amount, MAX_ADJUST_PAISE);
  const units = parsed.ok ? unitsForPaise(parsed.value, rate) : 0;
  const overdraw = kind === "debit" && target != null && units > target.balanceUnits;
  const canSubmit = parsed.ok && units > 0 && reason.trim().length > 0 && !overdraw && !saving;

  const submit = async () => {
    if (!target || !parsed.ok) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "adjust",
          account_id: target.id,
          kind,
          amount_rupees: amount.trim(),
          reason: reason.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("failed"));
      await onDone(
        kind === "credit"
          ? t("credited", { amount: formatRupeesExact(parsed.value), name: target.name })
          : t("debited", { amount: formatRupeesExact(parsed.value), name: target.name }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-popover border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <WalletIcon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {target &&
              t.rich("description", {
                name: target.name,
                email: target.email ?? "—",
                b: (chunks) => <strong className="text-foreground">{chunks}</strong>,
              })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("type")}</p>
            <div className="grid grid-cols-2 gap-3">
              {(["credit", "debit"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                  className={cn(
                    "inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition",
                    kind === k
                      ? k === "credit"
                        ? "border-transparent bg-gradient-to-r from-emerald-800 to-emerald-500 text-white shadow"
                        : "border-transparent bg-gradient-to-r from-red-700 to-red-500 text-white shadow"
                      : "border-border bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {k === "credit" ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  {k === "credit" ? t("credit") : t("debit")}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("quick")}</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_AMOUNTS.map((v) => {
                const on = amount.trim() === String(v);
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(String(v))}
                    className={cn(
                      "rounded-lg border px-3.5 py-1.5 text-sm font-semibold transition",
                      on
                        ? "border-transparent bg-gradient-to-r from-emerald-800 to-emerald-500 text-white"
                        : "border-border bg-card text-foreground hover:bg-muted",
                    )}
                  >
                    ₹{v.toLocaleString("en-IN")}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("amount")}</p>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">₹</span>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="pl-7 text-base font-semibold"
                aria-invalid={!parsed.ok}
              />
            </div>
            <p className={cn("mt-1.5 text-xs", !parsed.ok || overdraw ? "text-red-500" : "text-muted-foreground")}>
              {!parsed.ok
                ? parsed.error
                : overdraw
                  ? t("overdraw", { balance: formatRupeesExact(paiseForUnits(target!.balanceUnits, rate)) })
                  : t("preview", {
                      tokens: formatTokens(units),
                      after: formatRupeesExact(
                        paiseForUnits((target?.balanceUnits ?? 0) + (kind === "credit" ? units : -units), rate),
                      ),
                    })}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("reason")}</p>
            <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("cancel")}
          </Button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50",
              kind === "credit" ? "bg-gradient-to-r from-emerald-800 to-emerald-500" : "bg-gradient-to-r from-red-700 to-red-500",
            )}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {kind === "credit" ? t("submitCredit") : t("submitDebit")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

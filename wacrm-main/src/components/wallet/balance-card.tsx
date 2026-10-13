"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Coins } from "lucide-react";

import { useWallet } from "@/hooks/use-wallet";
import { formatTokens, messagesAffordable } from "@/lib/wallet/units";
import { cn } from "@/lib/utils";

/** Dashboard tile: current token balance and how many automated messages it covers. */
export function WalletBalanceCard() {
  const t = useTranslations("Wallet");
  const { data, loading, notMigrated } = useWallet();
  if (notMigrated || (!loading && !data)) return null;
  const units = data?.balance_units ?? 0;
  return (
    <Link
      href="/wallet"
      className={cn(
        "flex items-center gap-4 rounded-xl border bg-card p-5 transition-colors hover:border-primary/40",
        data?.paused ? "border-red-500/40" : "border-border",
      )}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Coins className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-muted-foreground">{t("balance")}</p>
        <p className="text-2xl font-bold tabular-nums text-foreground">
          {loading ? "…" : data?.unlimited ? t("unlimited") : t("tokens", { amount: formatTokens(units) })}
        </p>
      </div>
      <p className={cn("text-right text-xs", data?.paused ? "text-red-600 dark:text-red-300" : "text-muted-foreground")}>
        {data?.unlimited
          ? t("unlimitedShort")
          : data?.paused
            ? t("pausedShort")
            : t("covers", { count: messagesAffordable(units) })}
      </p>
    </Link>
  );
}

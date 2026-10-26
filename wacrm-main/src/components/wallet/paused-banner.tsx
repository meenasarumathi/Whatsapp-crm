"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";

import { useWallet } from "@/hooks/use-wallet";
import { INSUFFICIENT_TOKENS_MESSAGE } from "@/lib/wallet/policy";

/**
 * Shown on every page while the account can't pay for one automated
 * message. The sentence is fixed by the spec, so it comes from the
 * policy constant rather than the translation files.
 */
export function TokensPausedBanner() {
  const t = useTranslations("Wallet");
  const { data } = useWallet();
  if (!data?.paused) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{INSUFFICIENT_TOKENS_MESSAGE}</span>
      {data.is_owner && (
        <Link href="/wallet" className="font-medium underline underline-offset-2">
          {t("rechargeNow")}
        </Link>
      )}
    </div>
  );
}

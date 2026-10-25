"use client";

/**
 * Token Wallet — the account owner's balance, GPay instructions,
 * recharge form, request status, usage and full ledger history.
 * Other members of the account see the balance only.
 *
 * Every automated WhatsApp message (AI reply, automation, chatbot flow,
 * broadcast recipient, API send) costs 0.5 token. Manual replies are
 * free. Tokens never expire. Recharges are manual GPay transfers that an
 * admin checks and approves.
 */

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertTriangle,
  Coins,
  FileCheck2,
  History,
  Loader2,
  QrCode,
  Send,
  Wallet as WalletIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/hooks/use-wallet";
import { PlatformWalletAdmin } from "@/components/wallet/platform-wallet-admin";
import { cn } from "@/lib/utils";
import { INSUFFICIENT_TOKENS_MESSAGE } from "@/lib/wallet/policy";
import {
  CHARGE_UNITS,
  PROOF_TYPES,
  formatRupees,
  formatTokens,
  messagesAffordable,
  parseRupeesToPaise,
  unitsForPaise,
  validateProof,
} from "@/lib/wallet/units";

const STATUS_STYLE: Record<string, string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  approved: "border-emerald-600/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
};

export default function WalletPage() {
  const t = useTranslations("Wallet");
  const { data, loading, notMigrated, refresh } = useWallet();
  // Admin 1 / Admin 2 also own a normal (metered) account: let them
  // switch between the tenant view and their own wallet.
  const [view, setView] = useState<"platform" | "mine">("platform");

  if (loading) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  }
  if (notMigrated || !data) {
    return (
      <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">{t("notMigratedTitle")}</p>
          <p className="mt-1 text-amber-700/80 dark:text-amber-200/80">{t("notMigratedBody")}</p>
        </div>
      </div>
    );
  }

  // Platform admins land on the tenant wallets view (Wallet management).
  if (data.is_wallet_admin) {
    const canSwitch = !data.unlimited && data.is_owner;
    if (!canSwitch || view === "platform") {
      return (
        <div className="space-y-4">
          {canSwitch && <ViewSwitch view={view} onChange={setView} />}
          <PlatformWalletAdmin />
        </div>
      );
    }
  }

  return (
    <div className="space-y-6">
      {data.is_wallet_admin && !data.unlimited && data.is_owner && <ViewSwitch view={view} onChange={setView} />}
      <div>
        <div className="flex items-center gap-2">
          <WalletIcon className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {/* Balance */}
      <div
        className={cn(
          "grid gap-4 rounded-2xl border bg-card p-5 sm:grid-cols-[minmax(0,1fr)_auto]",
          data.paused ? "border-red-500/40" : "border-border",
        )}
      >
        <div>
          <p className="text-sm text-muted-foreground">{t("balance")}</p>
          <p className="mt-1 text-4xl font-bold tabular-nums text-foreground">
            {t("tokens", { amount: formatTokens(data.balance_units) })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("covers", { count: messagesAffordable(data.balance_units) })}
          </p>
          {data.paused && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {INSUFFICIENT_TOKENS_MESSAGE}
            </p>
          )}
        </div>
        <ul className="space-y-1 text-xs text-muted-foreground sm:max-w-xs">
          <li>• {t("ruleCharge")}</li>
          <li>• {t("ruleFree")}</li>
          <li>• {t("ruleExpiry")}</li>
        </ul>
      </div>

      {!data.is_owner ? (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("ownerOnly")}</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <GPayInstructions settings={data.settings ?? null} />
            <RechargeForm rate={data.settings ?? { rate_num: 1, rate_den: 1 }} onDone={refresh} />
          </div>
          <Requests requests={data.requests ?? []} />
          <Usage usage={data.usage_30d ?? {}} features={data.features ?? []} />
          <Ledger rows={data.ledger ?? []} />
        </>
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        {icon}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function GPayInstructions({
  settings,
}: {
  settings: { rate_num: number; rate_den: number; gpay_upi_id: string | null; gpay_payee_name: string | null; gpay_instructions: string | null } | null;
}) {
  const t = useTranslations("Wallet");
  const rateText = settings
    ? t("rate", { tokens: formatTokens(unitsForPaise(100, { num: settings.rate_num, den: settings.rate_den })) })
    : "";
  return (
    <Section icon={<QrCode className="h-4 w-4 text-primary" />} title={t("howTitle")}>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
        <li>
          {t("step1")}
          {settings?.gpay_upi_id ? (
            <span className="mt-1 block rounded-lg bg-muted px-3 py-2 font-mono text-sm">
              {settings.gpay_upi_id}
              {settings.gpay_payee_name ? <span className="ml-2 font-sans text-muted-foreground">({settings.gpay_payee_name})</span> : null}
            </span>
          ) : (
            <span className="mt-1 block text-muted-foreground">{t("noUpi")}</span>
          )}
        </li>
        <li>{t("step2")}</li>
        <li>{t("step3")}</li>
      </ol>
      {settings?.gpay_instructions ? (
        <p className="mt-3 whitespace-pre-wrap rounded-lg border border-border p-3 text-sm text-muted-foreground">
          {settings.gpay_instructions}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">{rateText}</p>
    </Section>
  );
}

function RechargeForm({ rate, onDone }: { rate: { rate_num: number; rate_den: number }; onDone: () => Promise<void> }) {
  const t = useTranslations("Wallet");
  const fileRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const parsed = useMemo(() => (amount.trim() ? parseRupeesToPaise(amount) : null), [amount]);
  const preview = parsed?.ok ? unitsForPaise(parsed.value, { num: rate.rate_num, den: rate.rate_den }) : null;

  const submit = async () => {
    if (!parsed?.ok) return;
    if (file) {
      const check = validateProof(file);
      if (!check.ok) {
        toast.error(check.error);
        return;
      }
    }
    setSaving(true);
    const form = new FormData();
    form.set("amount_rupees", amount.trim());
    if (reference.trim()) form.set("payment_reference", reference.trim());
    if (file) form.set("proof", file);
    try {
      const res = await fetch("/api/wallet/recharge", { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("submitFailed"));
      toast.success(t("submitted"));
      setAmount("");
      setReference("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("submitFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<Send className="h-4 w-4 text-primary" />} title={t("formTitle")}>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label>{t("amount")}</Label>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500" />
          {parsed && !parsed.ok ? (
            <p className="text-xs text-red-400">{parsed.error}</p>
          ) : preview !== null ? (
            <p className="text-xs text-muted-foreground">
              {t("youGet", { tokens: formatTokens(preview), count: Math.floor(preview / CHARGE_UNITS) })}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label>{t("reference")}</Label>
          <Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder={t("referencePlaceholder")} />
        </div>
        <div className="grid gap-1.5">
          <Label>{t("proof")}</Label>
          <input
            ref={fileRef}
            type="file"
            accept={Object.keys(PROOF_TYPES).join(",")}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-foreground"
          />
          <p className="text-[11px] text-muted-foreground">{t("proofHint")}</p>
        </div>
        <Button disabled={saving || !parsed?.ok} onClick={() => void submit()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t("submit")}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t("manualNote")}</p>
      </div>
    </Section>
  );
}

async function openProof(id: string) {
  const res = await fetch(`/api/wallet/admin/proof/${id}`);
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.url) window.open(json.url, "_blank", "noopener,noreferrer");
  else toast.error(json?.error ?? "Couldn't open the proof.");
}

function Requests({ requests }: { requests: NonNullable<ReturnType<typeof useWallet>["data"]>["requests"] }) {
  const t = useTranslations("Wallet");
  const list = requests ?? [];
  return (
    <Section icon={<FileCheck2 className="h-4 w-4 text-primary" />} title={t("requestsTitle")}>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noRequests")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("colDate")}</th>
                <th className="py-2 pr-3 font-medium">{t("colAmount")}</th>
                <th className="py-2 pr-3 font-medium">{t("colTokens")}</th>
                <th className="py-2 pr-3 font-medium">{t("colStatus")}</th>
                <th className="py-2 font-medium">{t("colNote")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatRupees(r.amount_paise)}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatTokens(r.tokens_units)}</td>
                  <td className="py-2 pr-3">
                    <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[r.status])}>
                      {t(`status.${r.status}`)}
                    </span>
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {r.decision_note ?? ""}
                    {r.has_proof && (
                      <button type="button" onClick={() => void openProof(r.id)} className="ml-2 text-primary hover:underline">
                        {t("viewProof")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Usage({ usage, features }: { usage: Record<string, number>; features: { feature: string; enabled: boolean }[] }) {
  const t = useTranslations("Wallet");
  const sources = ["ai_agent", "chatbot", "workflow", "broadcast", "api"];
  const total = sources.reduce((a, s) => a + (usage[s] ?? 0), 0);
  return (
    <Section icon={<Coins className="h-4 w-4 text-primary" />} title={t("usageTitle")}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {sources.map((s) => (
          <div key={s} className="rounded-xl border border-border p-3">
            <p className="text-[11px] text-muted-foreground">{t(`source.${s}`)}</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">{usage[s] ?? 0}</p>
          </div>
        ))}
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
          <p className="text-[11px] text-muted-foreground">{t("usageTotal")}</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums">
            {total} · {t("tokens", { amount: formatTokens(total * CHARGE_UNITS) })}
          </p>
        </div>
      </div>
      {features.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("featuresLine")}{" "}
          {features.map((f) => `${t(`source.${f.feature}`)}: ${f.enabled ? t("on") : t("off")}`).join(" · ")}
        </p>
      )}
    </Section>
  );
}

function Ledger({ rows }: { rows: NonNullable<ReturnType<typeof useWallet>["data"]>["ledger"] }) {
  const t = useTranslations("Wallet");
  const list = rows ?? [];
  return (
    <Section icon={<History className="h-4 w-4 text-primary" />} title={t("ledgerTitle")}>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noLedger")}</p>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("colDate")}</th>
                <th className="py-2 pr-3 font-medium">{t("colType")}</th>
                <th className="py-2 pr-3 text-right font-medium">{t("colChange")}</th>
                <th className="py-2 pr-3 text-right font-medium">{t("colBalance")}</th>
                <th className="py-2 font-medium">{t("colNote")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="py-1.5 pr-3">{t(`entry.${r.entry_type}`)}</td>
                  <td
                    className={cn(
                      "py-1.5 pr-3 text-right tabular-nums",
                      r.amount_units > 0 ? "text-emerald-400" : r.amount_units < 0 ? "text-red-400" : "text-muted-foreground",
                    )}
                  >
                    {r.amount_units > 0 ? "+" : ""}
                    {formatTokens(r.amount_units)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatTokens(r.balance_after_units)}</td>
                  <td className="py-1.5 text-muted-foreground">{r.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ViewSwitch({ view, onChange }: { view: "platform" | "mine"; onChange: (v: "platform" | "mine") => void }) {
  const t = useTranslations("Wallet.platform");
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
      {(["platform", "mine"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium",
            view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "platform" ? t("viewTenants") : t("viewMine")}
        </button>
      ))}
    </div>
  );
}

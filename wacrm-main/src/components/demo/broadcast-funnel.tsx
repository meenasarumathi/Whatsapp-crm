"use client";

/**
 * Demo → Broadcast funnel. Shows how one WhatsApp broadcast turns into
 * revenue, stage by stage, and what the CRM does at each stage. The
 * "AI follow-up funnel" switch shows the uplift from automatic
 * reminders + instant AI answers. Sample numbers only.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CheckCheck,
  Eye,
  Handshake,
  MessageCircleReply,
  Send,
  Sparkles,
  Target,
  Trophy,
  Users,
} from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

export const FUNNEL_STAGES = [
  "audience",
  "sent",
  "delivered",
  "read",
  "replied",
  "qualified",
  "deal",
  "won",
] as const;
type Stage = (typeof FUNNEL_STAGES)[number];

const STAGE_ICON: Record<Stage, typeof Users> = {
  audience: Users,
  sent: Send,
  delivered: CheckCheck,
  read: Eye,
  replied: MessageCircleReply,
  qualified: Target,
  deal: Handshake,
  won: Trophy,
};

/** Conversion from the previous stage, per sample campaign. */
const SCENARIOS = {
  festival: { audience: 10000, rates: [0.985, 0.956, 0.776, 0.29, 0.55, 0.35, 0.31], avgDeal: 2500 },
  cart: { audience: 2400, rates: [0.99, 0.97, 0.85, 0.38, 0.62, 0.5, 0.45], avgDeal: 1800 },
  webinar: { audience: 6000, rates: [0.98, 0.95, 0.7, 0.21, 0.48, 0.3, 0.25], avgDeal: 5000 },
} as const;
type Scenario = keyof typeof SCENARIOS;

/** Relative uplift from the follow-up funnel on read → replied and replied → qualified. */
const FOLLOW_UP_BOOST = { read: 1.06, replied: 1.45, qualified: 1.25 } as const;

export function computeFunnel(scenario: Scenario, followUp: boolean): number[] {
  const s = SCENARIOS[scenario];
  const counts: number[] = [s.audience];
  s.rates.forEach((rate, i) => {
    const stage = FUNNEL_STAGES[i + 1];
    const boost = followUp ? (FOLLOW_UP_BOOST[stage as keyof typeof FOLLOW_UP_BOOST] ?? 1) : 1;
    counts.push(Math.round(counts[i] * Math.min(rate * boost, 0.99)));
  });
  return counts;
}

export function BroadcastFunnelDemo() {
  const t = useTranslations("Demo.funnel");
  const { defaultCurrency } = useAuth();
  const [scenario, setScenario] = useState<Scenario>("festival");
  const [followUp, setFollowUp] = useState(true);
  const [active, setActive] = useState<Stage>("replied");
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const counts = useMemo(() => computeFunnel(scenario, followUp), [scenario, followUp]);
  const baseline = useMemo(() => computeFunnel(scenario, false), [scenario]);
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: defaultCurrency, maximumFractionDigits: 0 }).format(n);
  const revenue = counts[7] * SCENARIOS[scenario].avgDeal;
  const baseRevenue = baseline[7] * SCENARIOS[scenario].avgDeal;
  const top = counts[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(SCENARIOS) as Scenario[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScenario(s)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              scenario === s ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`scenarios.${s}`)}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
          <Sparkles className="h-3.5 w-3.5" />
          {t("followUpToggle")}
          <Switch checked={followUp} onCheckedChange={setFollowUp} />
        </label>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* The funnel */}
        <div className="space-y-1.5">
          {FUNNEL_STAGES.map((stage, i) => {
            const Icon = STAGE_ICON[stage];
            const pct = (counts[i] / top) * 100;
            // Keep the narrowest bar wide enough for its label + count.
            const width = 30 + (70 * pct) / 100;
            const prev = i === 0 ? null : (counts[i] / counts[i - 1]) * 100;
            const lift = counts[i] - baseline[i];
            return (
              <button
                key={stage}
                type="button"
                onClick={() => setActive(stage)}
                className="group block w-full text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="relative h-11 flex-1">
                    <div
                      className={cn(
                        "absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center justify-between gap-2 overflow-hidden rounded-lg px-3 text-xs font-medium transition-all duration-700 ease-out",
                        active === stage ? "ring-2 ring-primary" : "",
                        i >= 5 ? "bg-emerald-500/80 text-white" : i >= 3 ? "bg-primary/80 text-primary-foreground" : "bg-primary/35 text-foreground",
                      )}
                      style={{ width: grown ? `${width}%` : "30%" }}
                    >
                      <span className="flex min-w-0 items-center gap-1.5 truncate">
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{t(`stages.${stage}.label`)}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{counts[i].toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="w-24 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                    {prev === null ? "100%" : `${prev.toFixed(0)}% ${t("ofPrev")}`}
                    {followUp && lift > 0 && (
                      <span className="block text-emerald-400">+{lift.toLocaleString()}</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* What happens at this stage */}
        <div className="space-y-3">
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">{t(`stages.${active}.label`)}</p>
            <p className="mt-2 text-sm text-foreground">{t(`stages.${active}.what`)}</p>
            <p className="mt-2 text-xs text-muted-foreground">{t(`stages.${active}.crm`)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label={t("revenue")} value={money(revenue)} highlight />
            <Metric label={t("withoutFollowUp")} value={money(baseRevenue)} />
            <Metric label={t("replyRate")} value={`${((counts[4] / counts[1]) * 100).toFixed(1)}%`} />
            <Metric label={t("winRate")} value={`${((counts[7] / counts[1]) * 100).toFixed(2)}%`} />
          </div>
          {followUp && revenue > baseRevenue && (
            <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
              {t("uplift", { amount: money(revenue - baseRevenue), pct: Math.round(((revenue - baseRevenue) / baseRevenue) * 100) })}
            </p>
          )}
        </div>
      </div>

      {/* The follow-up funnel automations */}
      <div>
        <p className="text-sm font-semibold text-foreground">{t("automationsTitle")}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {(["noRead", "noReply", "replied", "qualified"] as const).map((key, i) => (
            <div key={key} className="rounded-xl border border-border bg-card p-3">
              <span className="text-[10px] font-semibold text-primary">{t("step", { n: i + 1 })}</span>
              <p className="mt-1 text-sm font-medium text-foreground">{t(`rules.${key}.when`)}</p>
              <p className="mt-1 text-xs text-muted-foreground">→ {t(`rules.${key}.then`)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-3", highlight ? "border-emerald-600/40 bg-emerald-500/10" : "border-border bg-card")}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-lg font-bold tabular-nums", highlight ? "text-emerald-300" : "text-foreground")}>{value}</p>
    </div>
  );
}

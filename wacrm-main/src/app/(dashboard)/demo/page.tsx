"use client";

/**
 * Demo — a presentation page for showing the CRM to a prospect.
 *
 * Leads with the two differentiators — the broadcast funnel and AI
 * training — then plays an automation end to end and closes with
 * everything else that's included. All numbers and chats are sample
 * data; nothing here touches WhatsApp or the account's records.
 * "Present" puts the page in full screen for screen-sharing.
 */

import { useRef } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Bell,
  Crown,
  FileSpreadsheet,
  Filter,
  GitBranch,
  GraduationCap,
  Maximize2,
  MessageSquare,
  Presentation,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { BroadcastFunnelDemo } from "@/components/demo/broadcast-funnel";
import { AiTrainingDemo } from "@/components/demo/ai-training-demo";
import { AutomationDemo } from "@/components/demo/automation-demo";

const SECTIONS = ["funnel", "ai", "automation", "everything"] as const;

const EVERYTHING = [
  { key: "inbox", icon: MessageSquare },
  { key: "contacts", icon: Users },
  { key: "pipelines", icon: GitBranch },
  { key: "broadcasts", icon: Radio },
  { key: "automations", icon: Zap },
  { key: "flows", icon: Workflow },
  { key: "notifications", icon: Bell },
  { key: "excel", icon: FileSpreadsheet },
  { key: "team", icon: ShieldCheck },
  { key: "plans", icon: Crown },
] as const;

export default function DemoPage() {
  const t = useTranslations("Demo");
  const rootRef = useRef<HTMLDivElement>(null);

  const present = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  const jump = (id: string) =>
    document.getElementById(`demo-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div ref={rootRef} className="space-y-10 overflow-y-auto bg-background pb-10 [&:fullscreen]:p-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-primary/20 via-card to-emerald-500/10 p-6 sm:p-10">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Presentation className="h-3.5 w-3.5" />
            {t("badge")}
          </span>
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{t("sampleData")}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={present}>
            <Maximize2 className="h-3.5 w-3.5" />
            {t("present")}
          </Button>
        </div>
        <h1 className="mt-5 max-w-3xl text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{t("heroTitle")}</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">{t("heroSubtitle")}</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <UspCard icon={<Filter className="h-5 w-5" />} title={t("usp1Title")} body={t("usp1Body")} onClick={() => jump("funnel")} />
          <UspCard icon={<GraduationCap className="h-5 w-5" />} title={t("usp2Title")} body={t("usp2Body")} onClick={() => jump("ai")} />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {SECTIONS.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => jump(s)}
              className="rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {i + 1}. {t(`nav.${s}`)}
            </button>
          ))}
        </div>
      </section>

      <DemoSection id="funnel" index={1} usp title={t("funnelTitle")} subtitle={t("funnelSubtitle")}>
        <BroadcastFunnelDemo />
      </DemoSection>

      <DemoSection id="ai" index={2} usp title={t("aiTitle")} subtitle={t("aiSubtitle")}>
        <AiTrainingDemo />
        <div className="mt-4">
          <Link href="/train-ai" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <GraduationCap className="h-3.5 w-3.5" />
            {t("openTrainAi")}
          </Link>
        </div>
      </DemoSection>

      <DemoSection id="automation" index={3} title={t("automationTitle")} subtitle={t("automationSubtitle")}>
        <AutomationDemo />
      </DemoSection>

      <DemoSection id="everything" index={4} title={t("everythingTitle")} subtitle={t("everythingSubtitle")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {EVERYTHING.map(({ key, icon: Icon }) => (
            <div key={key} className="rounded-xl border border-border bg-card p-4">
              <Icon className="h-5 w-5 text-primary" />
              <p className="mt-2 text-sm font-semibold text-foreground">{t(`features.${key}.title`)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t(`features.${key}.desc`)}</p>
            </div>
          ))}
        </div>
      </DemoSection>

      {/* Close */}
      <section className="rounded-3xl border border-emerald-600/40 bg-emerald-500/10 p-6 text-center sm:p-10">
        <Sparkles className="mx-auto h-6 w-6 text-emerald-300" />
        <h2 className="mt-3 text-2xl font-bold text-foreground">{t("ctaTitle")}</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">{t("ctaBody")}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {[1, 7, 15].map((d) => (
            <span key={d} className="rounded-full border border-emerald-600/40 bg-card px-3 py-1.5 text-sm font-medium text-emerald-300">
              {t("trialChip", { count: d })}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function UspCard({ icon, title, body, onClick }: { icon: React.ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group rounded-2xl border border-primary/30 bg-card/80 p-4 text-left transition-colors hover:border-primary"
    >
      <div className="flex items-center gap-2 text-primary">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">USP</span>
      </div>
      <p className="mt-2 text-base font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </button>
  );
}

function DemoSection({
  id,
  index,
  usp,
  title,
  subtitle,
  children,
}: {
  id: string;
  index: number;
  usp?: boolean;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("Demo");
  return (
    <section id={`demo-${id}`} className="scroll-mt-4 rounded-3xl border border-border bg-card-2 p-5 sm:p-8">
      <div className="mb-5 flex flex-wrap items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
            {usp && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                {t("uspTag")}
              </span>
            )}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

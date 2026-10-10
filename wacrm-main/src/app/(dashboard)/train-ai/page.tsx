"use client";

/**
 * Train AI — one friendly place to teach the AI assistant.
 *
 *   1 Business profile   guided questions about the business
 *   2 Q&A answers        "customer asks … → we reply …" pairs
 *   3 Rules              always / never instructions
 *   4 Learn from chats   turn good inbox conversations into Q&A
 *   5 Documents          the existing knowledge base (PDF / text)
 *   6 Test               chat with the AI before going live
 *   7 What AI can do     every AI feature in the CRM, with its status
 *
 * Everything is stored per account (ai_training_profiles /
 * ai_training_examples from migration 044, ai_knowledge_* from 030) and
 * used by inbox drafts, the auto-reply bot and the playground.
 */

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Circle,
  FileText,
  GraduationCap,
  Languages,
  ListChecks,
  MessageSquareQuote,
  MessagesSquare,
  PenLine,
  Sparkles,
  Store,
  UserRoundCheck,
  Workflow,
  Zap,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { canEditSettings, canSendMessages } from "@/lib/auth/roles";
import { readinessScore, profileCompleteness, PROFILE_FIELDS } from "@/lib/ai/training";
import { cn } from "@/lib/utils";
import { AiPlayground } from "@/components/agents/ai-playground";
import { AiKnowledgeCard } from "@/components/settings/ai-knowledge";
import { useTraining } from "@/components/train-ai/use-training";
import { ProfileForm } from "@/components/train-ai/profile-form";
import { ExamplesManager } from "@/components/train-ai/examples-manager";
import { LearnFromChats } from "@/components/train-ai/learn-from-chats";

type Step = "profile" | "qa" | "rules" | "learn" | "docs" | "test" | "abilities";

const STEPS: { id: Step; icon: typeof Store }[] = [
  { id: "profile", icon: Store },
  { id: "qa", icon: MessageSquareQuote },
  { id: "rules", icon: ListChecks },
  { id: "learn", icon: MessagesSquare },
  { id: "docs", icon: FileText },
  { id: "test", icon: Sparkles },
  { id: "abilities", icon: BrainCircuit },
];

export default function TrainAiPage() {
  const t = useTranslations("TrainAi");
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canSendMessages(accountRole) : false;
  const canEditDocs = accountRole ? canEditSettings(accountRole) : false;
  const data = useTraining();
  const [step, setStep] = useState<Step>("profile");

  const qaCount = data.rows.filter((r) => r.kind === "qa" && r.is_active).length;
  const ruleCount = data.rows.filter((r) => r.kind === "rule" && r.is_active).length;
  const score = readinessScore({
    profile: data.profile,
    qaCount,
    ruleCount,
    knowledgeDocs: data.knowledgeDocs,
  });
  const profilePct = Math.round(profileCompleteness(data.profile) * 100);

  const checklist: { done: boolean; label: string; step?: Step; href?: string }[] = [
    { done: data.aiConfigured, label: t("check.connect"), href: "/agents" },
    { done: profilePct >= 70, label: t("check.profile", { pct: profilePct }), step: "profile" },
    { done: qaCount >= 15, label: t("check.qa", { count: qaCount }), step: "qa" },
    { done: ruleCount >= 3, label: t("check.rules", { count: ruleCount }), step: "rules" },
    { done: data.knowledgeDocs >= 1, label: t("check.docs", { count: data.knowledgeDocs }), step: "docs" },
    { done: data.aiActive, label: t("check.live"), href: "/agents" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <GraduationCap className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {!data.loading && !data.ready && (
        <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">{t("notMigratedTitle")}</p>
            <p className="mt-1 text-amber-200/80">{t("notMigratedBody")}</p>
          </div>
        </div>
      )}

      {/* Readiness */}
      <div className="grid gap-4 rounded-2xl border border-border bg-card p-5 md:grid-cols-[180px_minmax(0,1fr)]">
        <div className="flex flex-col items-center justify-center">
          <ScoreRing value={score} />
          <p className="mt-2 text-sm font-medium text-foreground">{t("readiness")}</p>
          <p className="text-xs text-muted-foreground">
            {score >= 80 ? t("levelExpert") : score >= 50 ? t("levelGood") : score >= 20 ? t("levelLearning") : t("levelNew")}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{t("checklistTitle")}</p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {checklist.map((c) => {
              const inner = (
                <>
                  {c.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={c.done ? "text-foreground" : "text-muted-foreground"}>{c.label}</span>
                </>
              );
              return (
                <li key={c.label}>
                  {c.href ? (
                    <Link href={c.href} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                      {inner}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => c.step && setStep(c.step)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Steps */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 [scrollbar-width:none]">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              aria-pressed={step === s.id}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                step === s.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full text-[10px]",
                  step === s.id ? "bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {i + 1}
              </span>
              <Icon className="h-4 w-4" />
              {t(`steps.${s.id}`)}
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border bg-card-2 p-5">
        {data.loading ? null : step === "profile" ? (
          <ProfileForm profile={data.profile} canEdit={canEdit} onSaved={data.setProfile} />
        ) : step === "qa" ? (
          <ExamplesManager kind="qa" rows={data.rows} canEdit={canEdit} onChanged={data.reload} />
        ) : step === "rules" ? (
          <ExamplesManager kind="rule" rows={data.rows} canEdit={canEdit} onChanged={data.reload} />
        ) : step === "learn" ? (
          <LearnFromChats canEdit={canEdit} onSaved={data.reload} />
        ) : step === "docs" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("docsIntro")}</p>
            <AiKnowledgeCard accountId={accountId} canEdit={canEditDocs} hasEmbeddingsKey={data.hasEmbeddingsKey} />
          </div>
        ) : step === "test" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("testIntro")}</p>
            <AiPlayground />
          </div>
        ) : (
          <Abilities aiActive={data.aiActive} autoReply={data.autoReply} trained={qaCount + ruleCount > 0 || PROFILE_FIELDS.some((f) => data.profile[f.key])} />
        )}
      </div>
    </div>
  );
}

function ScoreRing({ value }: { value: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-32 w-32">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--muted)" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value / 100)}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-foreground">{value}</span>
        <span className="text-[10px] text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

function Abilities({ aiActive, autoReply, trained }: { aiActive: boolean; autoReply: boolean; trained: boolean }) {
  const t = useTranslations("TrainAi.abilities");
  const items: { key: string; icon: typeof Bot; on: boolean; href: string }[] = [
    { key: "autoReply", icon: Zap, on: aiActive && autoReply, href: "/agents" },
    { key: "drafts", icon: PenLine, on: aiActive, href: "/inbox" },
    { key: "handoff", icon: UserRoundCheck, on: aiActive && autoReply, href: "/agents" },
    { key: "languages", icon: Languages, on: aiActive, href: "/agents" },
    { key: "knowledge", icon: BookOpen, on: aiActive, href: "/train-ai" },
    { key: "training", icon: GraduationCap, on: trained, href: "/train-ai" },
    { key: "flows", icon: Workflow, on: true, href: "/flows" },
    { key: "funnel", icon: Sparkles, on: true, href: "/demo" },
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map(({ key, icon: Icon, on, href }) => (
          <Link
            key={key}
            href={href}
            className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  on ? "bg-emerald-500/10 text-emerald-300" : "bg-muted text-muted-foreground",
                )}
              >
                {on ? t("on") : t("off")}
              </span>
            </div>
            <p className="mt-3 text-sm font-semibold text-foreground">{t(`${key}.title`)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t(`${key}.desc`)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

"use client";

/**
 * Demo → AI training. Side-by-side "before / after training" answers to
 * the same customer question, plus the five-step training path the
 * Train AI page walks a business through. Scripted sample content.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, GraduationCap, Sparkles, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

const QUESTIONS = ["price", "delivery", "refund", "human"] as const;
type Question = (typeof QUESTIONS)[number];

const TRAINING_STEPS = ["profile", "qa", "rules", "learn", "test"] as const;

export function AiTrainingDemo() {
  const t = useTranslations("Demo.ai");
  const [question, setQuestion] = useState<Question>("price");
  const [typed, setTyped] = useState(0);
  const trained = t(`questions.${question}.trained`);

  // Type the trained answer out, like a live reply.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTyped(0);
    const id = setInterval(() => {
      setTyped((n) => {
        if (n >= trained.length) {
          clearInterval(id);
          return n;
        }
        return n + 3;
      });
    }, 18);
    return () => clearInterval(id);
  }, [trained]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setQuestion(q)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              question === q ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            “{t(`questions.${q}.ask`)}”
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChatCard
          title={t("before")}
          tone="muted"
          ask={t(`questions.${question}.ask`)}
          answer={t(`questions.${question}.untrained`)}
        />
        <ChatCard
          title={t("after")}
          tone="good"
          ask={t(`questions.${question}.ask`)}
          answer={trained.slice(0, typed)}
          note={t(`questions.${question}.why`)}
        />
      </div>

      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <GraduationCap className="h-4 w-4 text-primary" />
          {t("pathTitle")}
        </p>
        <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {TRAINING_STEPS.map((step, i) => (
            <li key={step} className="rounded-xl border border-border bg-card p-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                {i + 1}
              </span>
              <p className="mt-2 text-sm font-medium text-foreground">{t(`path.${step}.title`)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t(`path.${step}.desc`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ChatCard({
  title,
  tone,
  ask,
  answer,
  note,
}: {
  title: string;
  tone: "muted" | "good";
  ask: string;
  answer: string;
  note?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        tone === "good" ? "border-emerald-600/40 bg-emerald-500/5" : "border-border bg-card",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider",
          tone === "good" ? "text-emerald-300" : "text-muted-foreground",
        )}
      >
        {tone === "good" ? <Sparkles className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
        {title}
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex justify-end gap-2">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{ask}</div>
          <UserRound className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
        <div className="flex gap-2">
          <Bot className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-h-9 max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2 text-sm text-foreground">
            {answer}
          </div>
        </div>
      </div>
      {note && <p className="mt-3 text-[11px] text-emerald-300/90">✓ {note}</p>}
    </div>
  );
}

"use client";

/**
 * Demo → Automation in action. Plays a scripted WhatsApp conversation
 * on a phone mock-up while the matching flow steps light up beside it:
 * keyword trigger → buttons → capture name → tag "Hot lead" → AI answer
 * → hand off to a human with a deal in the pipeline. Sample only.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Bot,
  Handshake,
  KeyRound,
  ListChecks,
  MessageSquareText,
  Pause,
  Play,
  RotateCcw,
  Tag,
  UserRoundCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Each beat: who speaks, which flow step is lit, and optional buttons. */
const SCRIPT = [
  { who: "customer", key: "c1", step: "trigger" },
  { who: "bot", key: "b1", step: "buttons", buttons: ["monthly", "yearly", "sales"] },
  { who: "customer", key: "c2", step: "buttons", tap: true },
  { who: "bot", key: "b2", step: "collect" },
  { who: "customer", key: "c3", step: "collect" },
  { who: "system", key: "s1", step: "tag" },
  { who: "bot", key: "b3", step: "ai" },
  { who: "customer", key: "c4", step: "ai" },
  { who: "system", key: "s2", step: "handoff" },
  { who: "agent", key: "a1", step: "handoff" },
] as const;

const STEPS = [
  { id: "trigger", icon: KeyRound },
  { id: "buttons", icon: ListChecks },
  { id: "collect", icon: MessageSquareText },
  { id: "tag", icon: Tag },
  { id: "ai", icon: Bot },
  { id: "handoff", icon: UserRoundCheck },
] as const;

const BEAT_MS = 1700;

export function AutomationDemo() {
  const t = useTranslations("Demo.automation");
  const [shown, setShown] = useState(1);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing || shown >= SCRIPT.length) return;
    const id = setTimeout(() => setShown((n) => n + 1), BEAT_MS);
    return () => clearTimeout(id);
  }, [playing, shown]);

  const current = SCRIPT[Math.min(shown, SCRIPT.length) - 1];
  const done = shown >= SCRIPT.length;
  const litIndex = STEPS.findIndex((s) => s.id === current.step);

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* Phone */}
      <div className="mx-auto w-full max-w-[320px] rounded-[2rem] border-4 border-border bg-card p-2 shadow-xl">
        <div className="flex items-center gap-2 rounded-t-[1.5rem] bg-[#075E54] px-3 py-2 text-white">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-xs font-bold">A</div>
          <div className="text-xs">
            <p className="font-semibold">{t("businessName")}</p>
            <p className="text-white/70">{t("online")}</p>
          </div>
        </div>
        <div className="h-[420px] space-y-2 overflow-y-auto rounded-b-[1.5rem] bg-[#ECE5DD] p-3 dark:bg-[#0b141a]">
          {SCRIPT.slice(0, shown).map((beat, i) => {
            if (beat.who === "system") {
              return (
                <div key={i} className="flex justify-center">
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                    {t(`script.${beat.key}`)}
                  </span>
                </div>
              );
            }
            const fromCustomer = beat.who === "customer";
            return (
              <div key={i} className={cn("flex", fromCustomer ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-2.5 py-1.5 text-[12px] shadow-sm animate-in fade-in-0 slide-in-from-bottom-1",
                    fromCustomer ? "bg-[#DCF8C6] text-black dark:bg-[#005c4b] dark:text-white" : "bg-white text-black dark:bg-[#202c33] dark:text-white",
                  )}
                >
                  {beat.who === "agent" && (
                    <p className="mb-0.5 text-[10px] font-semibold text-[#128C7E]">{t("agentName")}</p>
                  )}
                  {"tap" in beat && beat.tap ? "↩ " : ""}
                  {t(`script.${beat.key}`)}
                  {"buttons" in beat && (
                    <div className="mt-1.5 space-y-1 border-t border-black/10 pt-1.5 dark:border-white/10">
                      {beat.buttons.map((b) => (
                        <div key={b} className="text-center text-[12px] font-medium text-[#128C7E]">
                          {t(`buttons.${b}`)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Flow steps */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setPlaying((p) => !p)} disabled={done}>
            {playing && !done ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {playing && !done ? t("pause") : t("play")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setShown(1);
              setPlaying(true);
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("replay")}
          </Button>
        </div>
        <ol className="space-y-2">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const state = i < litIndex || done ? "done" : i === litIndex ? "live" : "todo";
            return (
              <li
                key={s.id}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 transition-all duration-300",
                  state === "live" && "border-primary bg-primary/10 shadow-[0_0_0_3px_var(--primary-soft)]",
                  state === "done" && "border-emerald-600/40 bg-emerald-500/5",
                  state === "todo" && "border-border bg-card opacity-60",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                    state === "live" ? "bg-primary text-primary-foreground" : state === "done" ? "bg-emerald-500/20 text-emerald-300" : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{t(`steps.${s.id}.title`)}</p>
                  <p className="text-xs text-muted-foreground">{t(`steps.${s.id}.desc`)}</p>
                </div>
              </li>
            );
          })}
        </ol>
        {done && (
          <p className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            <Handshake className="h-4 w-4" />
            {t("result")}
          </p>
        )}
      </div>
    </div>
  );
}

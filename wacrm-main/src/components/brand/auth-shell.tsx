"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Bot, GitBranch, MessagesSquare } from "lucide-react";
import { BrandLockup, BrandMark } from "./brand-mark";

// Split layout for login / signup / password pages: the Zyloop story on
// the left (lg+), the form on the right. On phones only the form shows,
// with the lockup above it.
export function AuthShell({ children }: { children: ReactNode }) {
  const t = useTranslations("AuthShell");
  const points = [
    { icon: MessagesSquare, key: "inbox" },
    { icon: Bot, key: "ai" },
    { icon: GitBranch, key: "pipeline" },
  ] as const;

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="bg-brand-gradient absolute inset-0 opacity-[0.16]" />
        <div aria-hidden className="absolute -left-24 -top-24 h-96 w-96 rounded-full bg-cyan-400/20 blur-3xl" />
        <div aria-hidden className="absolute -bottom-32 right-0 h-[28rem] w-[28rem] rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="relative">
          <BrandLockup />
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight text-foreground">
            {t("headline")} <span className="text-brand-gradient">{t("headlineAccent")}</span>
          </h1>
          <p className="mt-4 text-base text-muted-foreground">{t("subline")}</p>
          <ul className="mt-8 space-y-4">
            {points.map(({ icon: Icon, key }) => (
              <li key={key} className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card/70 text-primary backdrop-blur">
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-foreground">{t(`points.${key}.title`)}</span>
                  <span className="block text-sm text-muted-foreground">{t(`points.${key}.desc`)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">{t("footer")}</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-center lg:hidden">
            <BrandMark className="h-11 w-11" />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

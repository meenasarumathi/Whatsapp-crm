"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Hourglass, Lock } from "lucide-react";

import { usePlatform } from "@/hooks/use-platform";
import { CRM_TABS, tabForPath } from "@/lib/platform/access";
import { buttonVariants } from "@/components/ui/button";

/**
 * Applies Settings → Subscription users to the page being viewed:
 *
 *   - Trial over / suspended → a "your access has ended" screen instead
 *     of the page (Settings stays reachable for profile and sign-out).
 *   - Tab switched off for this user → a "not on your plan" screen.
 *
 * The page itself never mounts in either case, so it doesn't fetch
 * data. While the platform lookup is in flight the page renders as
 * normal (fail-open) to avoid a blank flash for everyone.
 */
export function AccessGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Platform.guard");
  const pathname = usePathname();
  const { loading, hasAccess, status, canSeeTab, allowedTabs } = usePlatform();

  if (loading) return <>{children}</>;

  const onSettings = pathname.startsWith("/settings");
  const firstAllowed = CRM_TABS.find((tab) => allowedTabs.includes(tab.key));
  const homeHref = firstAllowed?.href ?? "/settings?tab=profile";

  if (!hasAccess && !onSettings) {
    return (
      <BlockedScreen
        icon={<Hourglass className="h-6 w-6" />}
        title={status === "suspended" ? t("suspendedTitle") : t("expiredTitle")}
        body={status === "suspended" ? t("suspendedBody") : t("expiredBody")}
        action={
          <Link href="/settings?tab=profile" className={buttonVariants()}>
            {t("openSettings")}
          </Link>
        }
      />
    );
  }

  const tab = tabForPath(pathname);
  if (tab && !canSeeTab(tab)) {
    return (
      <BlockedScreen
        icon={<Lock className="h-6 w-6" />}
        title={t("lockedTitle")}
        body={t("lockedBody")}
        action={
          <Link href={homeHref} className={buttonVariants()}>
            {t("goHome")}
          </Link>
        }
      />
    );
  }

  return <>{children}</>;
}

/** Slim "N days left on your free trial" strip for subscribers on a trial. */
export function TrialBanner() {
  const t = useTranslations("Platform.guard");
  const { loading, status, daysLeft, role } = usePlatform();
  if (loading || role !== "subscriber" || status !== "trial" || daysLeft == null) {
    return null;
  }
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
      <Hourglass className="h-4 w-4 shrink-0" />
      <span>{t("trialBanner", { count: daysLeft })}</span>
    </div>
  );
}

function BlockedScreen({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          {icon}
        </div>
        <h1 className="mt-4 text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        <div className="mt-6 flex justify-center">{action}</div>
      </div>
    </div>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  ALL_TAB_KEYS,
  isCrmTab,
  isPlatformRole,
  type CrmTab,
  type PlatformRole,
  type SubscriptionStatus,
} from "@/lib/platform/access";

interface PlatformContextValue {
  /** True until /api/platform/me has answered. */
  loading: boolean;
  /** False while migration 043 hasn't been applied — everything is open. */
  migrated: boolean;
  role: PlatformRole | null;
  status: SubscriptionStatus | null;
  /** Trial running or paid. False = show the "trial ended" screen. */
  hasAccess: boolean;
  daysLeft: number | null;
  trialEndsAt: string | null;
  allowedTabs: CrmTab[];
  /** Super admin / Admin 1 / Admin 2. */
  isPlatformAdmin: boolean;
  canSeeTab: (tab: CrmTab) => boolean;
  refresh: () => Promise<void>;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

interface MeResponse {
  migrated?: boolean;
  role?: string;
  status?: SubscriptionStatus;
  hasAccess?: boolean;
  daysLeft?: number | null;
  trialEndsAt?: string | null;
  allowedTabs?: string[];
}

/**
 * Loads the signed-in user's platform role, trial and tab access once
 * per session. Fails open (every tab visible) while loading or when the
 * lookup fails, so a network blip never blanks the sidebar; the
 * dashboard shell's guard re-checks once the answer arrives.
 */
export function PlatformProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/platform/me", { cache: "no-store" });
      setMe(res.ok ? ((await res.json()) as MeResponse) : null);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

  const value = useMemo<PlatformContextValue>(() => {
    const migrated = me?.migrated === true;
    const rawRole = me?.role;
    const role: PlatformRole | null =
      migrated && isPlatformRole(rawRole) ? rawRole : null;
    const rawTabs = me?.allowedTabs;
    const allowedTabs: CrmTab[] =
      migrated && Array.isArray(rawTabs)
        ? rawTabs.filter(isCrmTab)
        : [...ALL_TAB_KEYS];
    const hasAccess = migrated ? me?.hasAccess !== false : true;
    return {
      loading,
      migrated,
      role,
      status: migrated ? (me?.status ?? null) : null,
      hasAccess,
      daysLeft: migrated ? (me?.daysLeft ?? null) : null,
      trialEndsAt: migrated ? (me?.trialEndsAt ?? null) : null,
      allowedTabs,
      isPlatformAdmin: role !== null && role !== "subscriber",
      canSeeTab: (tab) => allowedTabs.includes(tab),
      refresh,
    };
  }, [loading, me, refresh]);

  return (
    <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error("usePlatform must be used inside <PlatformProvider>");
  return ctx;
}

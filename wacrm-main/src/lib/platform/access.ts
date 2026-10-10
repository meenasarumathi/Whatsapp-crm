// ============================================================
// Platform roles, subscription trials and per-user tab access —
// pure, unit-testable, no I/O.
//
// Mirrors `platform_users` from migration 043. These sit ABOVE the
// per-account roles in `@/lib/auth/roles`: account roles decide what a
// member can do inside one workspace; platform roles decide who runs
// the CRM as a product and what each subscriber may use.
//
// The sidebar, the dashboard route guard, the middleware and the
// /api/platform/* routes all call into this file so the rules live in
// one place.
// ============================================================

export type PlatformRole = "super_admin" | "admin1" | "admin2" | "subscriber";

export const PLATFORM_ROLES: readonly PlatformRole[] = [
  "super_admin",
  "admin1",
  "admin2",
  "subscriber",
] as const;

/** Roles a super admin can hand out from the UI. `super_admin` itself
 *  is set in SQL only, so one click can never lock the owner out. */
export const ASSIGNABLE_ROLES: readonly PlatformRole[] = [
  "admin1",
  "admin2",
  "subscriber",
] as const;

export type SubscriptionStatus = "trial" | "active" | "expired" | "suspended";

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trial",
  "active",
  "expired",
  "suspended",
] as const;

/** Trial lengths offered after someone subscribes. */
export const TRIAL_OPTIONS = [1, 7, 15] as const;
export type TrialDays = (typeof TRIAL_OPTIONS)[number];

/** Trial given automatically on self-signup (see migration 043). */
export const DEFAULT_SIGNUP_TRIAL_DAYS: TrialDays = 7;

// ------------------------------------------------------------
// Tabs
// ------------------------------------------------------------

/**
 * Every left-sidebar tab that can be switched on or off per user, in
 * sidebar order. Settings is deliberately absent: it holds the user's
 * own profile, password and WhatsApp connection, so it is always on.
 */
export const CRM_TABS = [
  { key: "dashboard", href: "/dashboard" },
  { key: "inbox", href: "/inbox" },
  { key: "train-ai", href: "/train-ai" },
  { key: "notifications", href: "/notifications" },
  { key: "contacts", href: "/contacts" },
  { key: "pipelines", href: "/pipelines" },
  { key: "broadcasts", href: "/broadcasts" },
  { key: "automations", href: "/automations" },
  { key: "flows", href: "/flows" },
  { key: "agents", href: "/agents" },
  { key: "demo", href: "/demo" },
  { key: "guide", href: "/guide" },
] as const;

export type CrmTab = (typeof CRM_TABS)[number]["key"];

export const ALL_TAB_KEYS: CrmTab[] = CRM_TABS.map((t) => t.key);

export function isCrmTab(value: unknown): value is CrmTab {
  return (
    typeof value === "string" && (ALL_TAB_KEYS as string[]).includes(value)
  );
}

/** The tab a pathname belongs to, or null for paths that aren't gated
 *  (settings, auth pages, API routes, …). */
export function tabForPath(pathname: string): CrmTab | null {
  for (const tab of CRM_TABS) {
    if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) {
      return tab.key;
    }
  }
  return null;
}

// ------------------------------------------------------------
// Row shape + derived state
// ------------------------------------------------------------

export interface PlatformUserRow {
  user_id: string;
  platform_role: PlatformRole;
  subscription_status: SubscriptionStatus;
  trial_days: number | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  /** NULL = every tab. */
  allowed_tabs: string[] | null;
  notes?: string | null;
}

export function isPlatformRole(value: unknown): value is PlatformRole {
  return (
    typeof value === "string" &&
    (PLATFORM_ROLES as readonly string[]).includes(value)
  );
}

export function isSubscriptionStatus(
  value: unknown,
): value is SubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isTrialDays(value: unknown): value is TrialDays {
  return (TRIAL_OPTIONS as readonly unknown[]).includes(value);
}

/** Super admin, Admin 1 and Admin 2 run the platform; subscribers use it. */
export function isPlatformAdmin(role: PlatformRole): boolean {
  return role !== "subscriber";
}

/**
 * Status as the app should treat it right now. A trial whose end date
 * has passed reads as `expired` without waiting for a cron to flip the
 * column. Platform admins are never expired or suspended.
 */
export function effectiveStatus(
  row: Pick<PlatformUserRow, "platform_role" | "subscription_status" | "trial_ends_at">,
  now: Date = new Date(),
): SubscriptionStatus {
  if (isPlatformAdmin(row.platform_role)) return "active";
  if (
    row.subscription_status === "trial" &&
    row.trial_ends_at &&
    new Date(row.trial_ends_at).getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return row.subscription_status;
}

/** Whole days left on a trial (rounded up), 0 when over, null when not on one. */
export function trialDaysLeft(
  row: Pick<PlatformUserRow, "subscription_status" | "trial_ends_at">,
  now: Date = new Date(),
): number | null {
  if (row.subscription_status !== "trial" || !row.trial_ends_at) return null;
  const ms = new Date(row.trial_ends_at).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/** True when the user may use the CRM at all (trial running or paid). */
export function hasActiveAccess(
  row: Pick<PlatformUserRow, "platform_role" | "subscription_status" | "trial_ends_at">,
  now: Date = new Date(),
): boolean {
  const status = effectiveStatus(row, now);
  return status === "trial" || status === "active";
}

/** Tabs the user can open. Super admins always get everything. */
export function allowedTabsFor(
  row: Pick<PlatformUserRow, "platform_role" | "allowed_tabs">,
): CrmTab[] {
  if (row.platform_role === "super_admin" || row.allowed_tabs == null) {
    return [...ALL_TAB_KEYS];
  }
  return ALL_TAB_KEYS.filter((t) => row.allowed_tabs!.includes(t));
}

export function canAccessTab(
  row: Pick<PlatformUserRow, "platform_role" | "allowed_tabs">,
  tab: CrmTab,
): boolean {
  return allowedTabsFor(row).includes(tab);
}

/**
 * Normalise a tab list from a request: drop unknown keys and
 * duplicates; a list that covers every tab collapses to NULL ("all"),
 * so tabs added later are on by default for those users. Returns
 * `undefined` for anything that isn't null or an array.
 */
export function normaliseTabs(input: unknown): string[] | null | undefined {
  if (input === null) return null;
  if (!Array.isArray(input)) return undefined;
  const picked = ALL_TAB_KEYS.filter((t) => input.includes(t));
  return picked.length === ALL_TAB_KEYS.length ? null : picked;
}

/** The ISO end date of a trial of `days` starting at `start`. */
export function trialEndsAt(days: TrialDays, start: Date = new Date()): string {
  return new Date(start.getTime() + days * 86_400_000).toISOString();
}

// ------------------------------------------------------------
// Who may change what
// ------------------------------------------------------------

export type PlatformChange = "role" | "tabs" | "status" | "trial" | "notes";

/**
 * Can `actor` make `change` to a user whose role is `target`?
 *
 *   super_admin — anything on admin1 / admin2 / subscriber.
 *   admin1      — tabs, status, trial and notes on subscribers.
 *   admin2      — trial and notes on subscribers.
 *   subscriber  — nothing.
 *
 * Nobody edits a super admin from the UI (that's SQL only).
 */
export function canChangePlatformUser(
  actor: PlatformRole,
  target: PlatformRole,
  change: PlatformChange,
): boolean {
  if (target === "super_admin") return false;
  switch (actor) {
    case "super_admin":
      return true;
    case "admin1":
      return target === "subscriber" && change !== "role";
    case "admin2":
      return target === "subscriber" && (change === "trial" || change === "notes");
    case "subscriber":
      return false;
  }
}

/** Creating users: super admin any assignable role, Admin 1 subscribers. */
export function canCreatePlatformUser(
  actor: PlatformRole,
  role: PlatformRole,
): boolean {
  if (role === "super_admin") return false;
  if (actor === "super_admin") return true;
  return actor === "admin1" && role === "subscriber";
}

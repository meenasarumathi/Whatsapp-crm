// ============================================================
// Server-side platform context for the /api/platform/* routes.
//
// Server-only (imports the SSR Supabase client). Reads and writes
// `platform_users` through the service role: RLS only lets a user read
// their own row, and every write is authorised here in TypeScript via
// the predicates in `./access`.
// ============================================================

import { createClient as createAdminClient, type SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";
import {
  DEFAULT_SIGNUP_TRIAL_DAYS,
  isPlatformAdmin,
  isPlatformRole,
  trialEndsAt,
  type PlatformRole,
  type PlatformUserRow,
} from "./access";

let _admin: SupabaseClient | null = null;

export function platformAdminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return _admin;
}

/** Thrown when migration 043 hasn't been applied yet. */
export class PlatformNotMigratedError extends Error {
  readonly status = 503 as const;
  constructor() {
    super(
      "Subscriptions are not set up yet. Run supabase/migrations/043_platform_users_subscriptions.sql in the Supabase SQL editor.",
    );
    this.name = "PlatformNotMigratedError";
  }
}

/** PostgREST / Postgres codes for "that table doesn't exist". */
export function isMissingTableError(err: { code?: string } | null): boolean {
  return !!err && (err.code === "42P01" || err.code === "PGRST205");
}

export const PLATFORM_COLUMNS =
  "user_id, platform_role, subscription_status, trial_days, trial_started_at, trial_ends_at, allowed_tabs, notes, created_at, updated_at";

/**
 * Load a user's platform row, creating the signup default (a
 * subscriber on a 7-day trial) if the signup trigger never wrote one.
 */
export async function loadPlatformUser(userId: string): Promise<PlatformUserRow> {
  const db = platformAdminClient();
  const { data, error } = await db
    .from("platform_users")
    .select(PLATFORM_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (isMissingTableError(error)) throw new PlatformNotMigratedError();
  if (error) throw error;
  if (data && isPlatformRole(data.platform_role)) return data as PlatformUserRow;

  const now = new Date();
  const fallback = {
    user_id: userId,
    platform_role: "subscriber" as const,
    subscription_status: "trial" as const,
    trial_days: DEFAULT_SIGNUP_TRIAL_DAYS,
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEndsAt(DEFAULT_SIGNUP_TRIAL_DAYS, now),
    allowed_tabs: null,
  };
  const { data: created, error: insErr } = await db
    .from("platform_users")
    .upsert(fallback, { onConflict: "user_id", ignoreDuplicates: true })
    .select(PLATFORM_COLUMNS)
    .maybeSingle();
  if (insErr) throw insErr;
  return (created as PlatformUserRow | null) ?? fallback;
}

export interface PlatformContext {
  userId: string;
  email: string | null;
  role: PlatformRole;
  row: PlatformUserRow;
}

/** Resolve the signed-in caller's platform row. */
export async function getPlatformContext(): Promise<PlatformContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();
  const row = await loadPlatformUser(user.id);
  return { userId: user.id, email: user.email ?? null, role: row.platform_role, row };
}

/** Like `getPlatformContext` but only for Super admin / Admin 1 / Admin 2. */
export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const ctx = await getPlatformContext();
  if (!isPlatformAdmin(ctx.role)) {
    throw new ForbiddenError("Only platform admins can manage subscriptions");
  }
  return ctx;
}

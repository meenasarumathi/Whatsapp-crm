import type { Row } from "@/lib/db/types";
// ============================================================
// /api/platform/users — Settings → Subscription users
//
//   GET    list every user with role, trial, status and tab access
//   POST   create a user (Super admin: any role; Admin 1: subscribers)
//   PATCH  update one or many users at once (the checkbox bulk bar)
//
// Platform admins only. Every read and write goes through the service
// role after the role checks in `@/lib/platform/access`.
// ============================================================

import { AuthError, createUserWithPassword } from "@/lib/auth/service";
import { NextResponse } from "next/server";

import { ForbiddenError, toErrorResponse } from "@/lib/auth/account";
import {
  allowedTabsFor,
  canChangePlatformUser,
  canCreatePlatformUser,
  effectiveStatus,
  isPlatformRole,
  isSubscriptionStatus,
  isTrialDays,
  normaliseTabs,
  trialDaysLeft,
  trialEndsAt,
  type PlatformChange,
  type PlatformUserRow,
} from "@/lib/platform/access";
import {
  PLATFORM_COLUMNS,
  PlatformNotMigratedError,
  isMissingTableError,
  platformAdminClient,
  requirePlatformAdmin,
} from "@/lib/platform/server";

const MAX_USERS = 2000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(err: unknown) {
  if (err instanceof PlatformNotMigratedError) {
    return NextResponse.json(
      { error: err.message, code: "not_migrated" },
      { status: err.status },
    );
  }
  return toErrorResponse(err);
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  account_id: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const db = platformAdminClient();

    const [platformRes, profilesRes] = await Promise.all([
      db.from("platform_users").select(PLATFORM_COLUMNS).limit(MAX_USERS),
      db
        .from("profiles")
        .select("user_id, full_name, email, account_id, created_at")
        .order("created_at", { ascending: false })
        .limit(MAX_USERS),
    ]);
    if (isMissingTableError(platformRes.error)) throw new PlatformNotMigratedError();
    if (platformRes.error) throw platformRes.error;
    if (profilesRes.error) throw profilesRes.error;

    const byUser = new Map(
      ((platformRes.data ?? []) as PlatformUserRow[]).map((r) => [r.user_id, r]),
    );

    const users = ((profilesRes.data ?? []) as ProfileRow[]).map((p) => {
      const row: PlatformUserRow = byUser.get(p.user_id) ?? {
        user_id: p.user_id,
        platform_role: "subscriber",
        subscription_status: "active",
        trial_days: null,
        trial_started_at: null,
        trial_ends_at: null,
        allowed_tabs: null,
        notes: null,
      };
      return {
        user_id: p.user_id,
        full_name: p.full_name ?? "",
        email: p.email ?? "",
        joined_at: p.created_at,
        platform_role: row.platform_role,
        stored_status: row.subscription_status,
        status: effectiveStatus(row),
        trial_days: row.trial_days,
        trial_ends_at: row.trial_ends_at,
        days_left: trialDaysLeft(row),
        allowed_tabs: allowedTabsFor(row),
        all_tabs: row.allowed_tabs == null,
        notes: row.notes ?? "",
        is_self: p.user_id === ctx.userId,
      };
    });

    return NextResponse.json({ me: { role: ctx.role, user_id: ctx.userId }, users });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const body = await request.json().catch(() => null);

    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const role = body?.platform_role;
    const trialDays = body?.trial_days ?? null;
    const tabs = normaliseTabs(body?.allowed_tabs ?? null);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 },
      );
    }
    if (!isPlatformRole(role)) {
      return NextResponse.json({ error: "Pick a role." }, { status: 400 });
    }
    if (!canCreatePlatformUser(ctx.role, role)) {
      throw new ForbiddenError("You can't create a user with that role.");
    }
    if (trialDays !== null && !isTrialDays(trialDays)) {
      return NextResponse.json(
        { error: "Trial must be 1, 7 or 15 days." },
        { status: 400 },
      );
    }
    if (tabs === undefined) {
      return NextResponse.json({ error: "Invalid tab list." }, { status: 400 });
    }

    const db = platformAdminClient();
    let created: { user: { id: string } };
    try {
      created = { user: await createUserWithPassword(email, password, fullName) };
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    const now = new Date();
    const isSubscriber = role === "subscriber";
    const onTrial = isSubscriber && trialDays !== null;
    const row = {
      user_id: created.user.id,
      platform_role: role,
      subscription_status: onTrial ? "trial" : "active",
      trial_days: onTrial ? trialDays : null,
      trial_started_at: onTrial ? now.toISOString() : null,
      trial_ends_at: onTrial ? trialEndsAt(trialDays, now) : null,
      allowed_tabs: tabs,
      updated_by: ctx.userId,
    };
    // The signup trigger has usually written a default row already;
    // upsert so ours wins either way.
    const { error: upsertErr } = await db
      .from("platform_users")
      .upsert(row, { onConflict: "user_id" });
    if (isMissingTableError(upsertErr)) throw new PlatformNotMigratedError();
    if (upsertErr) throw upsertErr;

    return NextResponse.json({ user_id: created.user.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const body = await request.json().catch(() => null);

    const userIds: string[] = Array.isArray(body?.user_ids)
      ? [...new Set<string>(body.user_ids.filter((id: unknown) => typeof id === "string" && UUID_RE.test(id)))]
      : [];
    if (userIds.length === 0) {
      return NextResponse.json({ error: "Select at least one user." }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};
    const changes: PlatformChange[] = [];
    const now = new Date();

    if (body.platform_role !== undefined) {
      if (!isPlatformRole(body.platform_role) || body.platform_role === "super_admin") {
        return NextResponse.json({ error: "Invalid role." }, { status: 400 });
      }
      patch.platform_role = body.platform_role;
      // Staff admins don't run on a trial clock.
      if (body.platform_role !== "subscriber") patch.subscription_status = "active";
      changes.push("role");
    }

    if (body.allowed_tabs !== undefined) {
      const tabs = normaliseTabs(body.allowed_tabs);
      if (tabs === undefined) {
        return NextResponse.json({ error: "Invalid tab list." }, { status: 400 });
      }
      patch.allowed_tabs = tabs;
      changes.push("tabs");
    }

    if (body.trial_days !== undefined) {
      if (!isTrialDays(body.trial_days)) {
        return NextResponse.json(
          { error: "Trial must be 1, 7 or 15 days." },
          { status: 400 },
        );
      }
      patch.subscription_status = "trial";
      patch.trial_days = body.trial_days;
      patch.trial_started_at = now.toISOString();
      patch.trial_ends_at = trialEndsAt(body.trial_days, now);
      changes.push("trial");
    } else if (body.subscription_status !== undefined) {
      if (
        !isSubscriptionStatus(body.subscription_status) ||
        body.subscription_status === "trial"
      ) {
        return NextResponse.json(
          { error: "Invalid status. To start a trial, pick 1, 7 or 15 days." },
          { status: 400 },
        );
      }
      patch.subscription_status = body.subscription_status;
      changes.push("status");
    }

    if (body.notes !== undefined) {
      if (typeof body.notes !== "string" || body.notes.length > 2000) {
        return NextResponse.json({ error: "Invalid notes." }, { status: 400 });
      }
      patch.notes = body.notes;
      changes.push("notes");
    }

    if (changes.length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const db = platformAdminClient();
    const { data: targets, error: loadErr } = await db
      .from("platform_users")
      .select("user_id, platform_role")
      .in("user_id", userIds);
    if (isMissingTableError(loadErr)) throw new PlatformNotMigratedError();
    if (loadErr) throw loadErr;

    const roleOf = new Map(
      (targets ?? []).map((t: Row) => [t.user_id as string, t.platform_role as string]),
    );
    for (const id of userIds) {
      // A user with no row yet is a subscriber by default.
      const target = roleOf.get(id) ?? "subscriber";
      if (!isPlatformRole(target)) continue;
      for (const change of changes) {
        if (!canChangePlatformUser(ctx.role, target, change)) {
          throw new ForbiddenError(
            `Your role can't change ${change === "tabs" ? "tab access" : change} for one of the selected users.`,
          );
        }
      }
    }

    // Users with no row yet get one first (active subscriber), then
    // every selected row receives only the patched columns.
    const missing = userIds.filter((id) => !roleOf.has(id));
    if (missing.length > 0) {
      const { error: insErr } = await db
        .from("platform_users")
        .upsert(
          missing.map((id) => ({ user_id: id, subscription_status: "active" })),
          { onConflict: "user_id", ignoreDuplicates: true },
        );
      if (insErr) throw insErr;
    }
    const { error: updErr } = await db
      .from("platform_users")
      .update({ ...patch, updated_by: ctx.userId })
      .in("user_id", userIds);
    if (updErr) throw updErr;

    return NextResponse.json({ updated: userIds.length });
  } catch (err) {
    return errorResponse(err);
  }
}

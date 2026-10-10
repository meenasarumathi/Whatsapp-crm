import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import {
  allowedTabsFor,
  effectiveStatus,
  hasActiveAccess,
  trialDaysLeft,
} from "@/lib/platform/access";
import {
  PlatformNotMigratedError,
  getPlatformContext,
} from "@/lib/platform/server";

/**
 * GET /api/platform/me
 *
 * The caller's platform role, subscription state and the sidebar tabs
 * they may open. Drives the sidebar filter, the dashboard route guard
 * and the trial banner. Before migration 043 is applied it answers with
 * `migrated: false` and full access, so the CRM keeps working.
 */
export async function GET() {
  try {
    const { role, row } = await getPlatformContext();
    return NextResponse.json({
      migrated: true,
      role,
      status: effectiveStatus(row),
      hasAccess: hasActiveAccess(row),
      trialDays: row.trial_days,
      trialEndsAt: row.trial_ends_at,
      daysLeft: trialDaysLeft(row),
      allowedTabs: allowedTabsFor(row),
    });
  } catch (err) {
    if (err instanceof PlatformNotMigratedError) {
      return NextResponse.json({ migrated: false });
    }
    return toErrorResponse(err);
  }
}

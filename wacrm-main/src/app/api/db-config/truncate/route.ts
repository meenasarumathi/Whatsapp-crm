// ============================================================
// POST /api/db-config/truncate — Settings → Backup → Database config
//
//   { tables: string[], confirm: "TRUNCATE", backup_confirmed: true }
//
// Empties the listed tables (TRUNCATE … RESTART IDENTITY, never
// CASCADE). Super admin only. The guards, in order:
//   1. the browser must say the pre-truncate backup was downloaded;
//   2. the caller types the word TRUNCATE;
//   3. accounts, profiles, platform_users and the audit log are locked;
//   4. the list must already contain every dependent table — it is
//      recomputed here, so a stale page can't wipe a different set;
//   5. every truncate is written to db_maintenance_log.
// ============================================================

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import {
  DbConfigError,
  DbConfigNotMigratedError,
  fetchDbTables,
  logMaintenance,
  truncateTables,
} from '@/lib/db-config/server';
import { TRUNCATE_CONFIRM_WORD, planTruncate } from '@/lib/db-config/tables';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  PlatformNotMigratedError,
  getPlatformContext,
} from '@/lib/platform/server';

const MAX_TABLES = 200;
const TRUNCATE_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };

function bad(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function POST(request: Request) {
  try {
    const ctx = await getPlatformContext();
    if (ctx.role !== 'super_admin') {
      throw new ForbiddenError('Only the Super admin can truncate tables');
    }

    const limit = checkRateLimit(
      `db-truncate:${ctx.userId}`,
      TRUNCATE_RATE_LIMIT
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      tables?: unknown;
      confirm?: unknown;
      backup_confirmed?: unknown;
    } | null;

    if (!body || !Array.isArray(body.tables) || body.tables.length === 0) {
      return bad('Choose at least one table');
    }
    if (
      body.tables.length > MAX_TABLES ||
      !body.tables.every((t) => typeof t === 'string')
    ) {
      return bad('Invalid table list');
    }
    if (body.backup_confirmed !== true) {
      return bad(
        'Download the backup first — nothing is truncated without one'
      );
    }
    if (body.confirm !== TRUNCATE_CONFIRM_WORD) {
      return bad(`Type ${TRUNCATE_CONFIRM_WORD} to confirm`);
    }

    const requested = [...new Set(body.tables as string[])].sort();
    const tables = await fetchDbTables();
    const known = new Set(tables.map((t) => t.name));
    const unknown = requested.filter((n) => !known.has(n));
    if (unknown.length > 0) return bad(`Unknown table: ${unknown.join(', ')}`);

    const plan = planTruncate(requested, tables);
    if (plan.blocked.length > 0) {
      return bad(
        `These tables are protected and can't be truncated: ${plan.blocked.join(', ')}`,
        400,
        {
          blocked: plan.blocked,
        }
      );
    }
    if (plan.added.length > 0) {
      return bad(
        'The list of dependent tables changed. Reload the page and review it again.',
        409,
        { required: plan.tables }
      );
    }

    const counts = await truncateTables(requested);
    await logMaintenance({
      action: 'truncate',
      tables: requested,
      row_counts: counts,
      performed_by: ctx.userId,
      performed_by_email: ctx.email,
    });

    return NextResponse.json({
      truncated: requested,
      rows_removed: Object.values(counts).reduce((a, b) => a + b, 0),
      counts,
    });
  } catch (err) {
    if (
      err instanceof DbConfigNotMigratedError ||
      err instanceof PlatformNotMigratedError
    ) {
      return NextResponse.json(
        { error: err.message, code: 'not_migrated' },
        { status: err.status }
      );
    }
    if (err instanceof DbConfigError) return bad(err.message, err.status);
    return toErrorResponse(err);
  }
}

// ============================================================
// GET /api/db-config — Settings → Backup → Database config
//
// Lists every public table with its columns, row count and foreign-key
// links, plus the most recent maintenance log entries. Super admin only.
//
// REBUILT 2026-10-16: the original file was lost before it was ever
// committed. It returns the shape the panel reads: { tables, log }.
// ============================================================

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import {
  DbConfigError,
  DbConfigNotMigratedError,
  fetchDbTables,
  recentMaintenance,
} from '@/lib/db-config/server';
import {
  PlatformNotMigratedError,
  getPlatformContext,
} from '@/lib/platform/server';

export async function GET() {
  try {
    const ctx = await getPlatformContext();
    if (ctx.role !== 'super_admin') {
      throw new ForbiddenError('Only the Super admin can view database config');
    }

    const [tables, log] = await Promise.all([
      fetchDbTables(),
      recentMaintenance(),
    ]);

    return NextResponse.json({ tables, log });
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
    if (err instanceof DbConfigError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}

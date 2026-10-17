// ============================================================
// GET /api/backup?scope=account|full — Settings → Backup
//
// Builds a JSON backup and returns it as a file download.
//
//   scope=account (default) — Owner / Admin. Reads every backup table
//     through the caller's own session, so RLS limits it to their
//     account's rows.
//   scope=full — Super admin only. Every table, every account, via the
//     service role.
//
// Secrets are redacted and embedding vectors dropped (`cleanRow`). A
// table that can't be read (not migrated yet, no access) is listed
// under `skipped` instead of failing the whole backup.
// ============================================================

import { NextResponse } from "next/server";
import type { DbClient } from '@/lib/db';

import { ForbiddenError, requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  PlatformNotMigratedError,
  getPlatformContext,
  platformAdminClient,
} from "@/lib/platform/server";
import {
  backupFileName,
  cleanRow,
  tablesFor,
  type BackupFile,
  type BackupScope,
} from "@/lib/backup/tables";

const PAGE = 1000;
const MAX_ROWS_PER_TABLE = 200_000;
/** Backups are heavy reads — a few per 10 minutes per user is plenty. */
const BACKUP_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };

export const maxDuration = 300;

async function readTable(
  db: DbClient,
  table: string,
  orderBy: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; error?: string }> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select("*")
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { rows, truncated: false, error: error.message };
    for (const row of data ?? []) rows.push(cleanRow(table, row as Record<string, unknown>));
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function GET(request: Request) {
  try {
    const scope: BackupScope =
      new URL(request.url).searchParams.get("scope") === "full" ? "full" : "account";

    let db: DbClient;
    let userId: string;
    let account: { id: string; name: string } | null = null;

    if (scope === "full") {
      const ctx = await getPlatformContext();
      if (ctx.role !== "super_admin") {
        throw new ForbiddenError("Only the Super admin can back up the whole database");
      }
      db = platformAdminClient();
      userId = ctx.userId;
    } else {
      const ctx = await requireRole("admin");
      db = ctx.db;
      userId = ctx.userId;
      account = ctx.account;
    }

    const limit = checkRateLimit(`backup:${userId}`, BACKUP_RATE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const now = new Date();
    const backup: BackupFile = {
      format: "wacrm-backup",
      version: 1,
      created_at: now.toISOString(),
      scope,
      account,
      created_by: userId,
      counts: {},
      skipped: {},
      truncated: [],
      notes: [
        "Secrets (API keys, access tokens, signing secrets, invite tokens) are replaced with [redacted]; re-enter them after a restore.",
        "AI knowledge embeddings are not included; re-index the knowledge base after a restore.",
        "Uploaded media files (images, documents, voice notes) are not included; messages keep their links.",
      ],
      tables: {},
    };

    // Sequential on purpose: keeps load on the database predictable.
    for (const table of tablesFor(scope)) {
      const result = await readTable(db, table.name, table.orderBy);
      if (result.error) {
        backup.skipped[table.name] = result.error;
        continue;
      }
      backup.tables[table.name] = result.rows;
      backup.counts[table.name] = result.rows.length;
      if (result.truncated) backup.truncated.push(table.name);
    }

    const filename = backupFileName(scope, account?.name ?? null, now);
    return new NextResponse(JSON.stringify(backup), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof PlatformNotMigratedError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}

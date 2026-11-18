// ============================================================
// Server-side helpers for /api/support. Server-only.
//
// The account and user ALWAYS come from the session, never from the
// request. Tickets live in server-only tables (RLS on, no policies), so
// every read/write uses the service connection after the checks in
// `./policy`.
// ============================================================

import { NextResponse } from "next/server";

import { createServiceDb, type DbClient, type Row } from "@/lib/db";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { PlatformNotMigratedError, loadPlatformUser } from "@/lib/platform/server";
import type { PlatformRole } from "@/lib/platform/access";
import { isSupportAdmin, type SupportActor, type TicketStatus } from "./policy";

let _db: DbClient | null = null;
export function supportDb(): DbClient {
  if (!_db) _db = createServiceDb();
  return _db;
}

export interface SupportContext extends SupportActor {
  accountId: string;
  isAdmin: boolean;
}

export async function getSupportContext(): Promise<SupportContext> {
  const ctx = await getCurrentAccount();
  let platformRole: PlatformRole | null = null;
  try {
    platformRole = (await loadPlatformUser(ctx.userId)).platform_role;
  } catch (err) {
    if (!(err instanceof PlatformNotMigratedError)) throw err;
  }
  return {
    userId: ctx.userId,
    accountId: ctx.accountId,
    platformRole,
    isAdmin: isSupportAdmin(platformRole),
  };
}

export class SupportInputError extends Error {
  readonly status = 400 as const;
}
export class SupportNotFoundError extends Error {
  readonly status = 404 as const;
  constructor() {
    super("Ticket not found.");
  }
}

function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

export function supportErrorResponse(err: unknown): NextResponse {
  if (err instanceof SupportInputError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof SupportNotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (isMissingTable(err)) {
    return NextResponse.json(
      { error: "Support tickets aren't set up yet. Run `npm run db:init`.", code: "not_migrated" },
      { status: 503 },
    );
  }
  return toErrorResponse(err);
}

export const TICKET_COLUMNS =
  "id, ticket_number, account_id, raised_by, subject, category, priority, status, resolution_note, resolved_by, resolved_at, created_at, updated_at";

export interface TicketRow {
  id: string;
  ticket_number: number;
  account_id: string;
  raised_by: string | null;
  subject: string;
  category: string;
  priority: string;
  status: TicketStatus;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** name / email for a set of user ids (raisers, authors). */
export async function peopleById(ids: (string | null)[]): Promise<Map<string, { name: string; email: string }>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const out = new Map<string, { name: string; email: string }>();
  if (unique.length === 0) return out;
  const { data, error } = await supportDb()
    .from("profiles")
    .select("user_id, full_name, email")
    .in("user_id", unique);
  if (error) throw error;
  for (const p of (data ?? []) as Row[]) {
    out.set(p.user_id as string, { name: (p.full_name as string) ?? "", email: (p.email as string) ?? "" });
  }
  return out;
}

/** In-app notification for the person who raised the ticket. Never throws. */
export async function notifyRaiser(
  ticket: TicketRow,
  actorUserId: string,
  title: string,
  body: string | null,
): Promise<void> {
  if (!ticket.raised_by || ticket.raised_by === actorUserId) return;
  const { error } = await supportDb()
    .from("notifications")
    .insert({
      account_id: ticket.account_id,
      user_id: ticket.raised_by,
      type: "support_ticket",
      ticket_id: ticket.id,
      actor_user_id: actorUserId,
      title,
      body: body ? body.slice(0, 500) : null,
    });
  if (error) console.error("[support] notification failed:", error.message);
}

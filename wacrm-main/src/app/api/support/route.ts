// ============================================================
// /api/support — Support tab (complaints / tickets)
//
//   GET   ?status=open|in_progress|resolved|closed|active|all
//         Users: the tickets they raised. Platform admins: every ticket,
//         with the account and raiser. Also returns per-status counts.
//   POST  { subject, category, priority, description } — raise a ticket.
// ============================================================

import { NextResponse } from "next/server";

import type { Row } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  TICKET_STATUSES,
  isTicketCategory,
  isTicketPriority,
  isTicketStatus,
  parseBody,
  parseSubject,
} from "@/lib/support/policy";
import {
  SupportInputError,
  TICKET_COLUMNS,
  getSupportContext,
  peopleById,
  supportDb,
  supportErrorResponse,
  type TicketRow,
} from "@/lib/support/server";

const MAX_TICKETS = 500;
const CREATE_RATE_LIMIT = { limit: 10, windowMs: 60 * 60_000 };

export async function GET(request: Request) {
  try {
    const ctx = await getSupportContext();
    const db = supportDb();
    const filter = new URL(request.url).searchParams.get("status") ?? "all";

    let query = db.from("support_tickets").select(TICKET_COLUMNS).order("updated_at", { ascending: false }).limit(MAX_TICKETS);
    if (!ctx.isAdmin) query = query.eq("raised_by", ctx.userId);
    const { data, error } = await query;
    if (error) throw error;
    const all = (data ?? []) as TicketRow[];

    const counts: Record<string, number> = { all: all.length, active: 0 };
    for (const s of TICKET_STATUSES) counts[s] = 0;
    for (const t of all) {
      counts[t.status] += 1;
      if (t.status === "open" || t.status === "in_progress") counts.active += 1;
    }

    const tickets = all.filter((t) =>
      filter === "all" ? true : filter === "active" ? t.status === "open" || t.status === "in_progress" : isTicketStatus(filter) && t.status === filter,
    );

    let accountName = new Map<string, string>();
    let people = new Map<string, { name: string; email: string }>();
    if (ctx.isAdmin && tickets.length > 0) {
      const ids = [...new Set(tickets.map((t) => t.account_id))];
      const { data: accounts, error: accErr } = await db.from("accounts").select("id, name").in("id", ids);
      if (accErr) throw accErr;
      accountName = new Map((accounts ?? []).map((a: Row) => [a.id as string, a.name as string]));
      people = await peopleById(tickets.map((t) => t.raised_by));
    }

    return NextResponse.json({
      is_admin: ctx.isAdmin,
      counts,
      tickets: tickets.map((t) => ({
        ...t,
        account_name: ctx.isAdmin ? (accountName.get(t.account_id) ?? null) : undefined,
        raised_by_name: ctx.isAdmin && t.raised_by ? (people.get(t.raised_by)?.name ?? null) : undefined,
        raised_by_email: ctx.isAdmin && t.raised_by ? (people.get(t.raised_by)?.email ?? null) : undefined,
      })),
    });
  } catch (err) {
    return supportErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getSupportContext();
    const limit = checkRateLimit(`support:${ctx.userId}`, CREATE_RATE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const subject = parseSubject(body?.subject);
    if (!subject.ok) throw new SupportInputError(subject.error);
    const description = parseBody(body?.description, "Description");
    if (!description.ok) throw new SupportInputError(description.error);
    const category = body?.category ?? "other";
    if (!isTicketCategory(category)) throw new SupportInputError("Pick a category.");
    const priority = body?.priority ?? "normal";
    if (!isTicketPriority(priority)) throw new SupportInputError("Pick a priority.");

    const db = supportDb();
    const { data: ticket, error } = await db
      .from("support_tickets")
      .insert({
        account_id: ctx.accountId,
        raised_by: ctx.userId,
        subject: subject.value,
        category,
        priority,
      })
      .select(TICKET_COLUMNS)
      .single();
    if (error) throw error;
    const t = ticket as TicketRow;

    const { error: msgErr } = await db.from("support_ticket_messages").insert({
      ticket_id: t.id,
      author_user_id: ctx.userId,
      from_admin: false,
      kind: "message",
      body: description.value,
    });
    if (msgErr) {
      await db.from("support_tickets").delete().eq("id", t.id);
      throw msgErr;
    }

    return NextResponse.json({ ticket: t }, { status: 201 });
  } catch (err) {
    return supportErrorResponse(err);
  }
}

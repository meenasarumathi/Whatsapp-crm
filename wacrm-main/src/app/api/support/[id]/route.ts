// ============================================================
// /api/support/[id] — one ticket
//
//   GET   the ticket and its conversation (raiser or platform admin).
//   POST  { action: "reply", body }
//         { action: "status", status, note? }   note required to resolve
//
// Admin replies and status changes notify the raiser in-app
// (Notifications tab, type 'support_ticket').
// ============================================================

import { NextResponse } from "next/server";

import { ForbiddenError } from "@/lib/auth/account";
import type { Row } from "@/lib/db";
import {
  STATUS_LABEL,
  canReply,
  canSetStatus,
  canViewTicket,
  isTicketStatus,
  parseBody,
  parseNote,
  statusAfterReply,
  statusNeedsNote,
  statusNotificationTitle,
} from "@/lib/support/policy";
import {
  SupportInputError,
  SupportNotFoundError,
  TICKET_COLUMNS,
  getSupportContext,
  notifyRaiser,
  peopleById,
  supportDb,
  supportErrorResponse,
  type SupportContext,
  type TicketRow,
} from "@/lib/support/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadTicket(ctx: SupportContext, id: string): Promise<TicketRow> {
  if (!UUID_RE.test(id)) throw new SupportNotFoundError();
  const { data, error } = await supportDb().from("support_tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  const t = data as TicketRow | null;
  // Someone else's ticket answers 404, not 403, so ids can't be probed.
  if (!t || !canViewTicket(ctx, t)) throw new SupportNotFoundError();
  return t;
}

async function ticketPayload(ctx: SupportContext, t: TicketRow) {
  const db = supportDb();
  const { data: msgs, error } = await db
    .from("support_ticket_messages")
    .select("id, author_user_id, from_admin, kind, body, created_at")
    .eq("ticket_id", t.id)
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw error;
  const messages = (msgs ?? []) as Row[];
  const people = await peopleById([t.raised_by, t.resolved_by, ...messages.map((m) => m.author_user_id as string | null)]);

  let accountName: string | null = null;
  if (ctx.isAdmin) {
    const { data: acc } = await db.from("accounts").select("name").eq("id", t.account_id).maybeSingle();
    accountName = (acc?.name as string) ?? null;
  }

  return {
    is_admin: ctx.isAdmin,
    me: ctx.userId,
    ticket: {
      ...t,
      account_name: accountName,
      raised_by_name: t.raised_by ? (people.get(t.raised_by)?.name ?? null) : null,
      raised_by_email: ctx.isAdmin && t.raised_by ? (people.get(t.raised_by)?.email ?? null) : null,
      resolved_by_name: t.resolved_by ? (people.get(t.resolved_by)?.name ?? null) : null,
    },
    messages: messages.map((m) => ({
      ...m,
      // Users see "Support team" for staff, not the staff member's email.
      author_name: m.from_admin
        ? ctx.isAdmin
          ? (people.get(m.author_user_id as string)?.name || "Support team")
          : "Support team"
        : (people.get(m.author_user_id as string)?.name ?? null),
    })),
  };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getSupportContext();
    const { id } = await context.params;
    const t = await loadTicket(ctx, id);
    return NextResponse.json(await ticketPayload(ctx, t));
  } catch (err) {
    return supportErrorResponse(err);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getSupportContext();
    const { id } = await context.params;
    const t = await loadTicket(ctx, id);
    const body = await request.json().catch(() => null);
    const db = supportDb();
    const now = new Date().toISOString();

    if (body?.action === "reply") {
      if (!canReply(ctx, t)) throw new ForbiddenError("This ticket is closed. Raise a new one if you still need help.");
      const parsed = parseBody(body.body);
      if (!parsed.ok) throw new SupportInputError(parsed.error);
      // An admin answering on someone else's ticket counts as staff.
      const fromAdmin = ctx.isAdmin && t.raised_by !== ctx.userId;

      const { error } = await db.from("support_ticket_messages").insert({
        ticket_id: t.id,
        author_user_id: ctx.userId,
        from_admin: fromAdmin,
        kind: "message",
        body: parsed.value,
      });
      if (error) throw error;

      const next = statusAfterReply(t, fromAdmin);
      const patch: Row = { updated_at: now };
      if (next !== t.status) {
        patch.status = next;
        patch.resolved_at = null;
        patch.resolved_by = null;
      }
      const { error: updErr } = await db.from("support_tickets").update(patch).eq("id", t.id);
      if (updErr) throw updErr;

      if (fromAdmin) {
        await notifyRaiser(t, ctx.userId, `New reply on ticket #${t.ticket_number}`, parsed.value);
      }
      const fresh = await loadTicket(ctx, t.id);
      return NextResponse.json(await ticketPayload(ctx, fresh));
    }

    if (body?.action === "status") {
      const next = body.status;
      if (!isTicketStatus(next)) throw new SupportInputError("Pick a status.");
      if (!canSetStatus(ctx, t, next)) throw new ForbiddenError("You can't change this ticket to that status.");
      const note = parseNote(body.note);
      if (!note.ok) throw new SupportInputError(note.error);
      if (statusNeedsNote(next) && !note.value) {
        throw new SupportInputError("Write what was done — the user reads this resolution note.");
      }

      const patch: Row = { status: next, updated_at: now };
      if (next === "resolved") {
        patch.resolution_note = note.value;
        patch.resolved_by = ctx.userId;
        patch.resolved_at = now;
      } else if (next === "open" || next === "in_progress") {
        patch.resolved_at = null;
        patch.resolved_by = null;
      }
      const { error: updErr } = await db.from("support_tickets").update(patch).eq("id", t.id);
      if (updErr) throw updErr;

      const fromAdmin = ctx.isAdmin && t.raised_by !== ctx.userId;
      const eventText = `Status changed to ${STATUS_LABEL[next]}${note.value ? `: ${note.value}` : ""}`;
      const { error: evErr } = await db.from("support_ticket_messages").insert({
        ticket_id: t.id,
        author_user_id: ctx.userId,
        from_admin: fromAdmin,
        kind: "event",
        body: eventText.slice(0, 5000),
      });
      if (evErr) throw evErr;

      if (fromAdmin) {
        await notifyRaiser(t, ctx.userId, statusNotificationTitle(t.ticket_number, next), note.value ?? t.subject);
      }
      const fresh = await loadTicket(ctx, t.id);
      return NextResponse.json(await ticketPayload(ctx, fresh));
    }

    throw new SupportInputError("Unknown action.");
  } catch (err) {
    return supportErrorResponse(err);
  }
}

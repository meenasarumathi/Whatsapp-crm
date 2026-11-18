// ============================================================
// Support tickets — statuses, input parsing and who may do what. Pure.
//
//   Raiser (any signed-in user): raise a ticket, reply on their own
//     ticket, close it, or reopen it after it was resolved.
//   Platform admin (super_admin / admin1 / admin2): see every ticket,
//     reply, move it to in_progress / resolved / closed / open.
//     Resolving needs a note — it is what the raiser reads.
//
// Every /api/support route calls these on the server; the UI mirrors them.
// ============================================================

import type { PlatformRole } from "@/lib/platform/access";

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CATEGORIES = ["bug", "whatsapp", "billing", "account", "feature", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
export const NOTE_MAX = 2000;

export function isTicketStatus(v: unknown): v is TicketStatus {
  return typeof v === "string" && (TICKET_STATUSES as readonly string[]).includes(v);
}
export function isTicketCategory(v: unknown): v is TicketCategory {
  return typeof v === "string" && (TICKET_CATEGORIES as readonly string[]).includes(v);
}
export function isTicketPriority(v: unknown): v is TicketPriority {
  return typeof v === "string" && (TICKET_PRIORITIES as readonly string[]).includes(v);
}

export function isSupportAdmin(role: PlatformRole | null): boolean {
  return role === "super_admin" || role === "admin1" || role === "admin2";
}

/** Open and in-progress tickets still need the team's attention. */
export function isActive(status: TicketStatus): boolean {
  return status === "open" || status === "in_progress";
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function parseSubject(v: unknown): Parsed<string> {
  const s = text(v);
  if (s.length < SUBJECT_MIN) return { ok: false, error: `Subject needs at least ${SUBJECT_MIN} characters.` };
  if (s.length > SUBJECT_MAX) return { ok: false, error: `Subject can be at most ${SUBJECT_MAX} characters.` };
  return { ok: true, value: s };
}

export function parseBody(v: unknown, label = "Message"): Parsed<string> {
  const s = text(v);
  if (!s) return { ok: false, error: `${label} can't be empty.` };
  if (s.length > BODY_MAX) return { ok: false, error: `${label} can be at most ${BODY_MAX} characters.` };
  return { ok: true, value: s };
}

export function parseNote(v: unknown): Parsed<string | null> {
  const s = text(v);
  if (s.length > NOTE_MAX) return { ok: false, error: `Note can be at most ${NOTE_MAX} characters.` };
  return { ok: true, value: s || null };
}

export interface SupportActor {
  userId: string;
  platformRole: PlatformRole | null;
}

export interface TicketRef {
  raised_by: string | null;
  status: TicketStatus;
}

export function canViewTicket(actor: SupportActor, t: TicketRef): boolean {
  return isSupportAdmin(actor.platformRole) || t.raised_by === actor.userId;
}

/** Replies are allowed until the ticket is closed. */
export function canReply(actor: SupportActor, t: TicketRef): boolean {
  return canViewTicket(actor, t) && t.status !== "closed";
}

/**
 * Can `actor` move ticket `t` to `next`?
 *   admins  — any change to a different status;
 *   raiser  — close their own ticket, or reopen a resolved one.
 */
export function canSetStatus(actor: SupportActor, t: TicketRef, next: TicketStatus): boolean {
  if (next === t.status) return false;
  if (isSupportAdmin(actor.platformRole)) return true;
  if (t.raised_by !== actor.userId) return false;
  if (next === "closed") return true;
  return next === "open" && t.status === "resolved";
}

/** A resolve without a note is refused: the note is the answer the user reads. */
export function statusNeedsNote(next: TicketStatus): boolean {
  return next === "resolved";
}

/**
 * When the raiser replies to a resolved ticket it goes back to open,
 * so the team sees it again. Admin replies don't change the status.
 */
export function statusAfterReply(t: TicketRef, fromAdmin: boolean): TicketStatus {
  if (!fromAdmin && t.status === "resolved") return "open";
  return t.status;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

/** Notification title the raiser gets for a status change. */
export function statusNotificationTitle(ticketNumber: number, next: TicketStatus): string {
  switch (next) {
    case "resolved":
      return `Ticket #${ticketNumber} resolved`;
    case "in_progress":
      return `Ticket #${ticketNumber} is being worked on`;
    case "closed":
      return `Ticket #${ticketNumber} closed`;
    case "open":
      return `Ticket #${ticketNumber} reopened`;
  }
}

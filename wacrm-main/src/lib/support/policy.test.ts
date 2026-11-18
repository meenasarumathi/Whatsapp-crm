import { describe, expect, it } from "vitest";

import {
  canReply,
  canSetStatus,
  canViewTicket,
  parseBody,
  parseSubject,
  statusAfterReply,
  statusNeedsNote,
  type SupportActor,
  type TicketRef,
} from "./policy";

const raiser: SupportActor = { userId: "u1", platformRole: "subscriber" };
const other: SupportActor = { userId: "u2", platformRole: "subscriber" };
const admin: SupportActor = { userId: "a1", platformRole: "admin2" };
const ticket = (status: TicketRef["status"]): TicketRef => ({ raised_by: "u1", status });

describe("support policy", () => {
  it("only the raiser and platform admins see a ticket", () => {
    expect(canViewTicket(raiser, ticket("open"))).toBe(true);
    expect(canViewTicket(admin, ticket("open"))).toBe(true);
    expect(canViewTicket(other, ticket("open"))).toBe(false);
    expect(canViewTicket({ userId: "x", platformRole: null }, ticket("open"))).toBe(false);
  });

  it("no replies on a closed ticket", () => {
    expect(canReply(raiser, ticket("resolved"))).toBe(true);
    expect(canReply(raiser, ticket("closed"))).toBe(false);
    expect(canReply(admin, ticket("closed"))).toBe(false);
    expect(canReply(other, ticket("open"))).toBe(false);
  });

  it("admins can move to any other status", () => {
    expect(canSetStatus(admin, ticket("open"), "in_progress")).toBe(true);
    expect(canSetStatus(admin, ticket("in_progress"), "resolved")).toBe(true);
    expect(canSetStatus(admin, ticket("closed"), "open")).toBe(true);
    expect(canSetStatus(admin, ticket("open"), "open")).toBe(false);
  });

  it("the raiser can close, or reopen only a resolved ticket", () => {
    expect(canSetStatus(raiser, ticket("open"), "closed")).toBe(true);
    expect(canSetStatus(raiser, ticket("resolved"), "open")).toBe(true);
    expect(canSetStatus(raiser, ticket("closed"), "open")).toBe(false);
    expect(canSetStatus(raiser, ticket("open"), "resolved")).toBe(false);
    expect(canSetStatus(raiser, ticket("open"), "in_progress")).toBe(false);
    expect(canSetStatus(other, ticket("open"), "closed")).toBe(false);
  });

  it("resolving needs a note", () => {
    expect(statusNeedsNote("resolved")).toBe(true);
    expect(statusNeedsNote("in_progress")).toBe(false);
  });

  it("a raiser reply reopens a resolved ticket; admin replies don't", () => {
    expect(statusAfterReply(ticket("resolved"), false)).toBe("open");
    expect(statusAfterReply(ticket("resolved"), true)).toBe("resolved");
    expect(statusAfterReply(ticket("in_progress"), false)).toBe("in_progress");
  });

  it("validates subject and body", () => {
    expect(parseSubject("  hi ").ok).toBe(false);
    expect(parseSubject("Broadcast stuck")).toEqual({ ok: true, value: "Broadcast stuck" });
    expect(parseSubject("x".repeat(151)).ok).toBe(false);
    expect(parseBody("   ").ok).toBe(false);
    expect(parseBody("x".repeat(5001)).ok).toBe(false);
    expect(parseBody(42).ok).toBe(false);
  });
});

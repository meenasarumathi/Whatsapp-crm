// ============================================================
// Server-side session helpers (Route Handlers, Server Components).
//
// Every authenticated request goes through getSessionState(): the cookie
// signature is checked, then the crm_auth_sessions row it names must be
// open (not logged out, revoked, expired or idle-timed-out). This is the
// backend enforcement point — the middleware only checks the signature
// because it runs on the Edge without database access.
//
// A session can be valid but restricted (temporary password not yet
// changed, or an Admin who has not set up MFA). getSessionUser() treats a
// restricted session as signed out, so every ordinary API refuses it; only
// the endpoints that resolve the restriction use requireSession({ allow }).
// ============================================================

import { cache } from "react";
import { cookies } from "next/headers";

import { resolveSession, type ResolvedSession } from "./security-service";
import type { SessionRestriction } from "./security-policy";
import { AuthError } from "./service";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSessionToken,
  verifySessionToken,
} from "./session-token";

export interface SessionUser {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  user_metadata: Record<string, unknown>;
}

/** The valid session of this request (possibly restricted), or null. One lookup per request. */
export const getSessionState = cache(async (): Promise<ResolvedSession | null> => {
  const store = await cookies();
  const claims = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;
  return resolveSession(claims);
});

export function toSessionUser(state: ResolvedSession): SessionUser {
  const meta = state.user.raw_user_meta_data ?? {};
  return {
    id: state.user.id,
    email: state.user.email,
    full_name: typeof meta.full_name === "string" ? meta.full_name : null,
    created_at: state.user.created_at,
    user_metadata: meta,
  };
}

/** The signed-in user with an unrestricted session, or null. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const state = await getSessionState();
  if (!state || state.restrictions.length > 0) return null;
  return toSessionUser(state);
});

export async function getSessionUserId(): Promise<string | null> {
  return (await getSessionUser())?.id ?? null;
}

/**
 * The current session, or a 401. `allow` lists the restrictions this
 * endpoint may be used with (e.g. the MFA setup endpoints allow
 * "mfa_enrollment"); any other restriction is a 403 naming what to do first.
 */
export async function requireSession(opts: { allow?: SessionRestriction[] } = {}): Promise<ResolvedSession> {
  const state = await getSessionState();
  if (!state) throw new AuthError("Not authenticated", 401, "unauthenticated");
  const blocking = state.restrictions.filter((r) => !(opts.allow ?? []).includes(r));
  if (blocking.length) {
    const msg =
      blocking[0] === "password_change"
        ? "Change your temporary password first"
        : "Set up two-step verification first";
    throw new AuthError(msg, 403, blocking[0]);
  }
  return state;
}

function cookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE) return process.env.AUTH_COOKIE_SECURE === "true";
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");
}

/** Sets the cookie for a session row created by security-service. */
export async function startSession(userId: string, sessionVersion: number, sessionId: string): Promise<void> {
  const token = await signSessionToken(userId, sessionVersion, sessionId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Clears the cookie (the session row is ended by the caller). */
export async function endSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: 0 });
}

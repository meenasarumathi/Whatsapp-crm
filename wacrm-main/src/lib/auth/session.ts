// ============================================================
// Server-side session helpers (Route Handlers, Server Components).
// ============================================================

import { cache } from "react";
import { cookies } from "next/headers";

import { getPool } from "@/lib/db/pool";
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

interface UserRow {
  id: string;
  email: string;
  raw_user_meta_data: Record<string, unknown> | null;
  session_version: number;
  created_at: string;
}

/** The signed-in user of this request, or null. One lookup per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const claims = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;
  const { rows } = await getPool().query<UserRow>(
    "SELECT id, email, raw_user_meta_data, session_version, created_at FROM public.users WHERE id = $1",
    [claims.sub],
  );
  const u = rows[0];
  if (!u || u.session_version !== claims.sv) return null;
  const meta = u.raw_user_meta_data ?? {};
  return {
    id: u.id,
    email: u.email,
    full_name: typeof meta.full_name === "string" ? meta.full_name : null,
    created_at: u.created_at,
    user_metadata: meta,
  };
});

export async function getSessionUserId(): Promise<string | null> {
  return (await getSessionUser())?.id ?? null;
}

function cookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE) return process.env.AUTH_COOKIE_SECURE === "true";
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");
}

/** Start a session for `userId` (sets the cookie). */
export async function startSession(userId: string, sessionVersion: number): Promise<void> {
  const token = await signSessionToken(userId, sessionVersion);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: 0 });
}

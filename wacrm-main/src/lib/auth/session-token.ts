// ============================================================
// Session cookie — a signed JWT (HS256). Runs in the Edge runtime too
// (middleware), so it only depends on `jose`.
//
//   sub  user id
//   sv   session version (bumped on "sign out everywhere")
//   sid  crm_auth_sessions.id — the server checks this row on every
//        request (revoked / logged out / timed out sessions stop working)
//
// Cookies issued before per-session tracking have no sid and are rejected,
// so every user signs in once more under the new model.
// ============================================================

import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "wacrm_session";
/** Matches SESSION_TTL_MS in security-policy.ts (7 days). */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface SessionClaims {
  sub: string;
  sv: number;
  sid: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must be set to a random string of at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(userId: string, sessionVersion: number, sessionId: string): Promise<string> {
  return new SignJWT({ sv: sessionVersion, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string | undefined | null): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.sv !== "number") return null;
    if (typeof payload.sid !== "string" || !UUID_RE.test(payload.sid)) return null;
    return { sub: payload.sub, sv: payload.sv, sid: payload.sid };
  } catch {
    return null;
  }
}

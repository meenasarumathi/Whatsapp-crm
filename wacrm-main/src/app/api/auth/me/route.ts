import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { endSession, getSessionState, toSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/session-token";

export const dynamic = "force-dynamic";

/**
 * { user, restrictions }. `user` is null when the session is restricted
 * (temporary password to change, or MFA set-up required for an Admin), so
 * the app treats it as signed out; `pending` then carries the user's email
 * and what must be done, for the /account-security page.
 */
export async function GET() {
  const state = await getSessionState();
  // A cookie with a valid signature but an ended session (logout elsewhere,
  // revoked, timed out, or a pre-session-tracking cookie) passes the
  // middleware, which would bounce /login back to /dashboard forever. Clear it.
  if (!state) {
    if ((await cookies()).has(SESSION_COOKIE)) await endSession();
    return NextResponse.json({ user: null, restrictions: [] });
  }
  if (state.restrictions.length) {
    return NextResponse.json({
      user: null,
      restrictions: state.restrictions,
      pending: { email: state.user.email },
    });
  }
  return NextResponse.json({ user: toSessionUser(state), restrictions: [] });
}

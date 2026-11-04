import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { endSession, getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/session-token";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  // A cookie with a valid signature but a revoked session version (password
  // reset, "sign out everywhere") passes the middleware, which would bounce
  // /login back to /dashboard forever. Clear it so the login page is reachable.
  if (!user && (await cookies()).has(SESSION_COOKIE)) await endSession();
  return NextResponse.json({ user });
}

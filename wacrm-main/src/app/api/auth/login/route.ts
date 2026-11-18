import { NextResponse } from "next/server";
import { startSession } from "@/lib/auth/session";
import { recordRateLimitedAttempt, signInSecure } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/**
 * Body { email, password, code?, recoveryCode? }.
 * 401 { error.code: "mfa_required" } → ask for the authenticator code and post again.
 * 200 { restrictions: [...] } → the client sends the user to /account-security first.
 */
export async function POST(request: Request) {
  const b = await readJson(request);
  const meta = requestMeta(request);
  const limited = authRateLimited(request, "login");
  if (limited) {
    await recordRateLimitedAttempt(b.email, meta);
    return limited;
  }
  try {
    const r = await signInSecure(
      { email: b.email, password: b.password, code: b.code, recoveryCode: b.recoveryCode },
      meta,
    );
    await startSession(r.userId, r.sessionVersion, r.sessionId);
    return NextResponse.json({ user: { id: r.userId, email: r.email }, restrictions: r.restrictions });
  } catch (e) {
    return errorResponse(e);
  }
}

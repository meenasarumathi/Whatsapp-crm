import { NextResponse } from "next/server";
import { startSession } from "@/lib/auth/session";
import { resetPasswordSecure } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/** Ends every session of the user. Signs in directly unless the user has MFA on (then: signInRequired). */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "reset");
  if (limited) return limited;
  try {
    const b = await readJson(request);
    const r = await resetPasswordSecure({ token: b.token, password: b.password, meta: requestMeta(request) });
    if (r.session) await startSession(r.userId, r.session.sessionVersion, r.session.sessionId);
    return NextResponse.json({ ok: true, signInRequired: !r.session });
  } catch (e) {
    return errorResponse(e);
  }
}

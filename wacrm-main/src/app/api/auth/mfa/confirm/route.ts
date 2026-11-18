import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { confirmMfaEnrollment } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/** Body { code }. Turns MFA on and returns the recovery codes (shown once). */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "mfa");
  if (limited) return limited;
  try {
    const s = await requireSession({ allow: ["mfa_enrollment"] });
    const b = await readJson(request);
    const r = await confirmMfaEnrollment({ userId: s.user.id, sessionId: s.sessionId, code: b.code, meta: requestMeta(request) });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

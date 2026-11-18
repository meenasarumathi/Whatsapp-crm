import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { changePasswordSecure } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/** Body { current, next }. Allowed while a temporary password must be changed. Ends the user's other sessions. */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "change-password");
  if (limited) return limited;
  try {
    const s = await requireSession({ allow: ["password_change", "mfa_enrollment"] });
    const b = await readJson(request);
    await changePasswordSecure({ userId: s.user.id, sessionId: s.sessionId, current: b.current, next: b.next, meta: requestMeta(request) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

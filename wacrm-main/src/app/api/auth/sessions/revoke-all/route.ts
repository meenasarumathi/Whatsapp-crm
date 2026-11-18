import { NextResponse } from "next/server";
import { endSession, requireSession } from "@/lib/auth/session";
import { revokeAllSessions } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/** Body { reason } (required). Ends every session of the caller, this one included. */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "revoke-all");
  if (limited) return limited;
  try {
    const s = await requireSession({ allow: ["password_change", "mfa_enrollment"] });
    const b = await readJson(request);
    const ended = await revokeAllSessions({ actorId: s.user.id, userId: s.user.id, reason: b.reason, meta: requestMeta(request) });
    await endSession();
    return NextResponse.json({ ok: true, ended });
  } catch (e) {
    return errorResponse(e);
  }
}

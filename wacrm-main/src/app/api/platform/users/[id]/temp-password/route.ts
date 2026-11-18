import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { issueTemporaryPassword } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, requestMeta } from "@/lib/auth/http";

/**
 * Issue a temporary password (valid 72 hours, must be changed at next sign-in)
 * for another user. Who may do it is decided in the service from the caller's
 * platform role in the database: Super Admin for anyone except Super Admins,
 * Admin (admin1 / admin2) for subscribers. The password is returned once.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = authRateLimited(request, "temp-password");
  if (limited) return limited;
  try {
    const s = await requireSession();
    const { id } = await context.params;
    const r = await issueTemporaryPassword({ actorId: s.user.id, targetUserId: id, meta: requestMeta(request) });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

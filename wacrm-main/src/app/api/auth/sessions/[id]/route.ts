import { NextResponse } from "next/server";
import { endSession, requireSession } from "@/lib/auth/session";
import { revokeSession } from "@/lib/auth/security-service";
import { errorResponse, requestMeta } from "@/lib/auth/http";

/** Sign out one of the caller's own sessions. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const s = await requireSession();
    const { id } = await context.params;
    await revokeSession({ actorId: s.user.id, userId: s.user.id, sessionId: id, meta: requestMeta(request) });
    if (id === s.sessionId) await endSession();
    return NextResponse.json({ ok: true, signedOut: id === s.sessionId });
  } catch (e) {
    return errorResponse(e);
  }
}

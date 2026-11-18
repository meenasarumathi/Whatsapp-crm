import { NextResponse } from "next/server";
import { endSession, getSessionState } from "@/lib/auth/session";
import { logoutSession, revokeAllSessions } from "@/lib/auth/security-service";
import { errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/**
 * Ends this session. Body { scope: "global", reason? } ends every session of
 * the user instead (same as POST /api/auth/sessions/revoke-all).
 */
export async function POST(request: Request) {
  try {
    const b = await readJson(request);
    const state = await getSessionState();
    if (state) {
      if (b.scope === "global") {
        const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason : "Signed out of all devices";
        await revokeAllSessions({ actorId: state.user.id, userId: state.user.id, reason, meta: requestMeta(request) });
      } else {
        await logoutSession(state.user.id, state.sessionId);
      }
    }
    await endSession();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

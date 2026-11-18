import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { listSessions } from "@/lib/auth/security-service";
import { errorResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

/** The caller's open sessions (devices), newest activity first. */
export async function GET() {
  try {
    const s = await requireSession();
    return NextResponse.json({ sessions: await listSessions(s.user.id, s.sessionId) });
  } catch (e) {
    return errorResponse(e);
  }
}

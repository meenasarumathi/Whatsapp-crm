import { NextResponse } from "next/server";
import { endSession, getSessionUserId } from "@/lib/auth/session";
import { revokeAllSessions } from "@/lib/auth/service";
import { errorResponse, readJson } from "@/lib/auth/http";

/** Body { scope: "global" } also invalidates the user's other sessions. */
export async function POST(request: Request) {
  try {
    const b = await readJson(request);
    const userId = await getSessionUserId();
    if (userId && b.scope === "global") await revokeAllSessions(userId);
    await endSession();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

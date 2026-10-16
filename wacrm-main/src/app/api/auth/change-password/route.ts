import { NextResponse } from "next/server";
import { getSessionUserId, startSession } from "@/lib/auth/session";
import { AuthError, changePassword } from "@/lib/auth/service";
import { authRateLimited, errorResponse, readJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  const limited = authRateLimited(request, "change-password");
  if (limited) return limited;
  try {
    const userId = await getSessionUserId();
    if (!userId) throw new AuthError("Not authenticated", 401);
    const b = await readJson(request);
    const u = await changePassword(userId, b.current, b.next);
    await startSession(u.id, u.session_version);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

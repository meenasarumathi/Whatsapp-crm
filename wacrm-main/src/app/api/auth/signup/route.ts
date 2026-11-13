import { NextResponse } from "next/server";
import { startSession } from "@/lib/auth/session";
import { signUp } from "@/lib/auth/service";
import { createSession } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

export async function POST(request: Request) {
  const limited = authRateLimited(request, "signup");
  if (limited) return limited;
  try {
    const b = await readJson(request);
    const u = await signUp(b.email, b.password, b.fullName);
    const s = await createSession(u.id, requestMeta(request), { mfaVerified: false });
    await startSession(u.id, s.sessionVersion, s.sessionId);
    return NextResponse.json({ user: { id: u.id, email: u.email } });
  } catch (e) {
    return errorResponse(e);
  }
}

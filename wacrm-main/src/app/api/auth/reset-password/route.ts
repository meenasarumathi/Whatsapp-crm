import { NextResponse } from "next/server";
import { startSession } from "@/lib/auth/session";
import { resetPassword } from "@/lib/auth/service";
import { authRateLimited, errorResponse, readJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  const limited = authRateLimited(request, "reset");
  if (limited) return limited;
  try {
    const b = await readJson(request);
    const u = await resetPassword(b.token, b.password);
    await startSession(u.id, u.session_version);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

import { NextResponse } from "next/server";
import { startSession } from "@/lib/auth/session";
import { signIn } from "@/lib/auth/service";
import { authRateLimited, errorResponse, readJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  const limited = authRateLimited(request, "login");
  if (limited) return limited;
  try {
    const b = await readJson(request);
    const u = await signIn(b.email, b.password);
    await startSession(u.id, u.session_version);
    return NextResponse.json({ user: { id: u.id, email: u.email } });
  } catch (e) {
    return errorResponse(e);
  }
}

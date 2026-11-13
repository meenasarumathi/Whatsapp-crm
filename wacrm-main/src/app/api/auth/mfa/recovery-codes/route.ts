import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { regenerateRecoveryCodes } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/** Body { code }. New recovery codes (shown once); the old ones stop working. */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "mfa");
  if (limited) return limited;
  try {
    const s = await requireSession();
    const b = await readJson(request);
    const recoveryCodes = await regenerateRecoveryCodes({ userId: s.user.id, code: b.code, meta: requestMeta(request) });
    return NextResponse.json({ recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

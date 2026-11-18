import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { startMfaEnrollment } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse } from "@/lib/auth/http";

/** Step 1 of MFA set-up: a new secret, shown once. Not active until confirmed. */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "mfa");
  if (limited) return limited;
  try {
    const s = await requireSession({ allow: ["mfa_enrollment"] });
    const r = await startMfaEnrollment(s.user.id, s.user.email);
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

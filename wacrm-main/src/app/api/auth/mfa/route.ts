import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getMfaStatus } from "@/lib/auth/security-service";
import { errorResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

/** { enabled, mandatory, canDisable, enrollmentPending, recoveryCodesLeft } for the caller. */
export async function GET() {
  try {
    const s = await requireSession({ allow: ["mfa_enrollment"] });
    return NextResponse.json(await getMfaStatus(s.user.id, s.role));
  } catch (e) {
    return errorResponse(e);
  }
}

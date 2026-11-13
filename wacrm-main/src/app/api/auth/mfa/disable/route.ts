import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { disableMfa } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, readJson, requestMeta } from "@/lib/auth/http";

/** Body { password, code }. Refused (403) for Super Admin and Admin, whose MFA is mandatory. */
export async function POST(request: Request) {
  const limited = authRateLimited(request, "mfa");
  if (limited) return limited;
  try {
    const s = await requireSession();
    const b = await readJson(request);
    await disableMfa({ userId: s.user.id, role: s.role, password: b.password, code: b.code, meta: requestMeta(request) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

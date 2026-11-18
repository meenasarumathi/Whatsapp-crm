import { NextResponse } from "next/server";
import { requestPasswordResetSecure } from "@/lib/auth/security-service";
import { authRateLimited, errorResponse, originOf, readJson, requestMeta } from "@/lib/auth/http";

export async function POST(request: Request) {
  const limited = authRateLimited(request, "forgot");
  if (limited) return limited;
  try {
    const b = await readJson(request);
    await requestPasswordResetSecure(b.email, originOf(request), requestMeta(request));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

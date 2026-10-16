import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/service";
import { authRateLimited, errorResponse, originOf, readJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  const limited = authRateLimited(request, "forgot");
  if (limited) return limited;
  try {
    const b = await readJson(request);
    await requestPasswordReset(b.email, originOf(request));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

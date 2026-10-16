import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth/session";
import { AuthError, changeEmail } from "@/lib/auth/service";
import { errorResponse, readJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  try {
    const userId = await getSessionUserId();
    if (!userId) throw new AuthError("Not authenticated", 401);
    const b = await readJson(request);
    await changeEmail(userId, b.email);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

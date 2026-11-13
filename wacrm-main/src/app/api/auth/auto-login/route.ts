import { NextResponse, type NextRequest } from "next/server";

import { authBypassUserId, safeNextPath } from "@/lib/auth/auth-bypass";
import { startSession } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";

// Signs in the AUTH_BYPASS_USER_ID user and continues to the page they asked for.
export async function GET(request: NextRequest) {
  const userId = authBypassUserId(request.headers.get("host"));
  if (!userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { rows } = await getPool()
    .query<{ session_version: number }>("SELECT session_version FROM public.users WHERE id = $1", [userId])
    .catch(() => ({ rows: [] as { session_version: number }[] }));
  if (!rows[0]) {
    // Not a redirect to /login: the middleware would send it straight back here.
    return NextResponse.json({ error: "AUTH_BYPASS_USER_ID does not match a user" }, { status: 500 });
  }

  await startSession(userId, rows[0].session_version);
  return new NextResponse(null, {
    status: 307,
    headers: { Location: safeNextPath(request.nextUrl.searchParams.get("next")) },
  });
}

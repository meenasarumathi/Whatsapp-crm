import { NextResponse } from "next/server";

import { createUserDb } from "@/lib/db/client";
import { getSessionUserId } from "@/lib/auth/session";
import { runGateway, validateGateway, type GatewayRequest } from "@/lib/db/gateway";

export const dynamic = "force-dynamic";

/**
 * Data gateway for browser components. Every statement runs as the
 * signed-in user with Row Level Security applied; anonymous callers get 401.
 */
export async function POST(request: Request) {
  if (!(await getSessionUserId())) {
    return NextResponse.json({ data: null, error: { message: "Not authenticated", code: "401" }, count: null }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ data: null, error: { message: "Invalid JSON", code: "400" }, count: null }, { status: 400 });
  }
  const problem = validateGateway(body);
  if (problem) return NextResponse.json({ data: null, error: { message: problem, code: "400" }, count: null }, { status: 400 });
  const db = await createUserDb();
  return NextResponse.json(await runGateway(db, body as GatewayRequest));
}

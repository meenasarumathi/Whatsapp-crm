import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { AuthError } from "./service";

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

/** Returns a 429 response when the caller is over the auth budget. */
export function authRateLimited(request: Request, scope: string): NextResponse | null {
  const r = checkRateLimit(`auth:${scope}:${clientIp(request)}`, RATE_LIMITS.auth);
  return r.success ? null : rateLimitResponse(r);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: { message: e.message } }, { status: e.status });
  console.error("[auth]", e);
  return NextResponse.json({ error: { message: "Something went wrong" } }, { status: 500 });
}

export function originOf(request: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site) return site.replace(/\/$/, "");
  return new URL(request.url).origin;
}

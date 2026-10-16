import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";

const { middleware } = await import("./middleware");
const { SESSION_COOKIE, signSessionToken } = await import("@/lib/auth/session-token");

let signedIn: string;
beforeAll(async () => {
  signedIn = `${SESSION_COOKIE}=${await signSessionToken("user-1", 1)}`;
});

const req = (path: string, cookie?: string) =>
  new NextRequest(`https://app.test${path}`, { headers: cookie ? { cookie } : {} });

describe("middleware", () => {
  it("redirects a signed-in user off /login to the dashboard", async () => {
    const res = await middleware(req("/login", signedIn));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("sends a signed-in user with an invite token to /join/<token>", async () => {
    const res = await middleware(req("/login?invite=abc123", signedIn));
    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("redirects an anonymous user from a protected page to /login", async () => {
    const res = await middleware(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("treats a forged or expired cookie as anonymous", async () => {
    const res = await middleware(req("/dashboard", `${SESSION_COOKIE}=garbage`));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("returns 401 for unauthenticated whatsapp API calls but lets webhooks through", async () => {
    expect((await middleware(req("/api/whatsapp/send"))).status).toBe(401);
    expect((await middleware(req("/api/whatsapp/webhook"))).status).toBe(200);
  });

  it("passes a signed-in user through on a protected page", async () => {
    const res = await middleware(req("/dashboard", signedIn));
    expect(res.headers.get("location")).toBeNull();
  });
});

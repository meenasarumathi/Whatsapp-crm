import { afterEach, describe, expect, it, vi } from "vitest";

import { authBypassUserId, safeNextPath } from "./auth-bypass";

afterEach(() => vi.unstubAllEnvs());

describe("authBypassUserId", () => {
  it("is off unless AUTH_BYPASS_USER_ID is set", () => {
    vi.stubEnv("AUTH_BYPASS_USER_ID", "");
    expect(authBypassUserId("localhost:3000")).toBeNull();
  });

  it.each(["localhost:3000", "localhost", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST:3000"])("applies on %s", (host) => {
    vi.stubEnv("AUTH_BYPASS_USER_ID", "user-1");
    expect(authBypassUserId(host)).toBe("user-1");
  });

  it.each(["abc123.ngrok-free.app", "crm.example.com:443", "localhost.evil.com", "192.168.1.5:3000", "", null])(
    "does not apply on %s",
    (host) => {
      vi.stubEnv("AUTH_BYPASS_USER_ID", "user-1");
      expect(authBypassUserId(host)).toBeNull();
    },
  );

  it("never applies on a production server", () => {
    vi.stubEnv("AUTH_BYPASS_USER_ID", "user-1");
    vi.stubEnv("NODE_ENV", "production");
    expect(authBypassUserId("localhost:3000")).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/inbox?x=1")).toBe("/inbox?x=1");
  });

  it.each([null, "", "https://evil.com", "//evil.com", "/\\evil.com"])("falls back to the dashboard for %s", (next) => {
    expect(safeNextPath(next)).toBe("/dashboard");
  });
});

import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { signSessionToken, verifySessionToken } from "./session-token";

const SECRET = "test-auth-secret-that-is-at-least-32-chars-long";
const SID = "11111111-2222-4333-8444-555555555555";
const UID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

describe("session token", () => {
  it("carries user id, session version and session id", async () => {
    const token = await signSessionToken(UID, 3, SID);
    expect(await verifySessionToken(token)).toEqual({ sub: UID, sv: 3, sid: SID });
  });

  it("rejects a pre-Phase-1 cookie that has no session id (forces one fresh sign-in)", async () => {
    const legacy = await new SignJWT({ sv: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(UID)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySessionToken(legacy)).toBeNull();
  });

  it("rejects a session id that is not a uuid", async () => {
    const bad = await new SignJWT({ sv: 1, sid: "not-a-uuid" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(UID)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySessionToken(bad)).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const forged = await new SignJWT({ sv: 1, sid: SID })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(UID)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("another-secret-another-secret-another"));
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it("rejects empty input", async () => {
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  LOCKOUT_MS,
  LOCKOUT_THRESHOLD,
  SESSION_TTL_MS,
  SUPER_ADMIN_IDLE_MS,
  TEMP_PASSWORD_TTL_MS,
  canDisableMfa,
  canIssueTempPassword,
  checkSession,
  decideLogin,
  isMfaMandatory,
  permissionLevel,
  sessionRestrictions,
  validateRevokeReason,
  type LoginEvidence,
  type LoginSubject,
  type SessionFacts,
} from "./security-policy";

const NOW = new Date("2026-11-13T10:00:00Z");
const mins = (n: number) => n * 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);

const subject = (over: Partial<LoginSubject> = {}): LoginSubject => ({
  role: "subscriber",
  lifecycleStatus: null,
  mfaEnabled: false,
  failedLoginCount: 0,
  lockedUntil: null,
  mustChangePassword: false,
  tempPasswordExpiresAt: null,
  ...over,
});
const ev = (over: Partial<LoginEvidence> = {}): LoginEvidence => ({
  passwordOk: true,
  totpProvided: false,
  totpOk: false,
  recoveryProvided: false,
  recoveryOk: false,
  ...over,
});

// ---------------------------------------------------------------- roles
describe("permission levels (admin1 and admin2 are both Admin)", () => {
  it.each([
    ["super_admin", "super_admin"],
    ["admin1", "admin"],
    ["admin2", "admin"],
    ["subscriber", "user"],
    [null, "user"],
  ] as const)("%s → %s", (role, level) => {
    expect(permissionLevel(role)).toBe(level);
  });

  it("MFA is mandatory for Super Admin and Admin only", () => {
    expect(isMfaMandatory("super_admin")).toBe(true);
    expect(isMfaMandatory("admin1")).toBe(true);
    expect(isMfaMandatory("admin2")).toBe(true);
    expect(isMfaMandatory("subscriber")).toBe(false);
    expect(isMfaMandatory(null)).toBe(false);
  });

  it("users whose MFA is mandatory cannot turn it off", () => {
    expect(canDisableMfa("super_admin")).toBe(false);
    expect(canDisableMfa("admin1")).toBe(false);
    expect(canDisableMfa("admin2")).toBe(false);
    expect(canDisableMfa("subscriber")).toBe(true);
  });
});

describe("who may issue a temporary password", () => {
  it.each([
    ["super_admin", "admin1", true],
    ["super_admin", "admin2", true],
    ["super_admin", "subscriber", true],
    ["super_admin", "super_admin", false], // super admins are managed in SQL only
    ["admin1", "subscriber", true],
    ["admin2", "subscriber", true],
    ["admin1", "admin2", false],
    ["admin2", "admin1", false],
    ["admin1", "super_admin", false],
    ["subscriber", "subscriber", false],
  ] as const)("%s → %s: %s", (actor, target, allowed) => {
    expect(canIssueTempPassword(actor, target)).toBe(allowed);
  });
});

// ---------------------------------------------------------------- login
describe("decideLogin", () => {
  it("unknown email: generic failure, no session, no lock bookkeeping", () => {
    const d = decideLogin(null, ev({ passwordOk: false }), NOW);
    expect(d.outcome).toBe("unknown_user");
    expect(d.createSession).toBe(false);
    expect(d.error?.code).toBe("invalid_credentials");
  });

  it("wrong password: records bad_password, counts the failure, no session", () => {
    const d = decideLogin(subject({ failedLoginCount: 1 }), ev({ passwordOk: false }), NOW);
    expect(d.outcome).toBe("bad_password");
    expect(d.createSession).toBe(false);
    expect(d.failedLoginCount).toBe(2);
    expect(d.lockedNow).toBe(false);
    expect(d.error?.code).toBe("invalid_credentials");
  });

  it(`the ${LOCKOUT_THRESHOLD}th consecutive failure locks the account for 15 minutes`, () => {
    const d = decideLogin(subject({ failedLoginCount: LOCKOUT_THRESHOLD - 1 }), ev({ passwordOk: false }), NOW);
    expect(d.outcome).toBe("bad_password");
    expect(d.lockedNow).toBe(true);
    expect(d.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCKOUT_MS);
    expect(LOCKOUT_MS).toBe(mins(15));
    expect(d.failedLoginCount).toBe(0); // fresh budget once the lock ends
    expect(d.error?.code).toBe("locked");
  });

  it("while locked, even the right password is refused as 'locked' and nothing changes", () => {
    const s = subject({ lockedUntil: later(mins(10)), failedLoginCount: 0 });
    const d = decideLogin(s, ev({ passwordOk: true }), NOW);
    expect(d.outcome).toBe("locked");
    expect(d.createSession).toBe(false);
    expect(d.lockedUntil).toEqual(s.lockedUntil);
    expect(d.lockedNow).toBe(false);
    expect(d.error?.code).toBe("locked");
    expect(d.error?.status).toBe(423);
  });

  it("after the lock expires the user can sign in and the counter resets", () => {
    const d = decideLogin(subject({ lockedUntil: ago(1), failedLoginCount: 0 }), ev(), NOW);
    expect(d.outcome).toBe("success");
    expect(d.createSession).toBe(true);
    expect(d.lockedUntil).toBeNull();
    expect(d.failedLoginCount).toBe(0);
  });

  it("a success resets earlier failures", () => {
    const d = decideLogin(subject({ failedLoginCount: 4 }), ev(), NOW);
    expect(d.failedLoginCount).toBe(0);
    expect(d.createSession).toBe(true);
  });

  it.each(["suspended", "disabled", "left"] as const)(
    "a %s user is refused even with the right password, without revealing it to a wrong password",
    (status) => {
      const right = decideLogin(subject({ lifecycleStatus: status }), ev(), NOW);
      expect(right.outcome).toBe(status);
      expect(right.createSession).toBe(false);
      expect(right.error?.status).toBe(403);
      const wrong = decideLogin(subject({ lifecycleStatus: status }), ev({ passwordOk: false }), NOW);
      expect(wrong.outcome).toBe("bad_password");
      expect(wrong.error?.code).toBe("invalid_credentials");
    },
  );

  it("an expired temporary password is refused", () => {
    const d = decideLogin(
      subject({ mustChangePassword: true, tempPasswordExpiresAt: ago(1) }),
      ev(),
      NOW,
    );
    expect(d.outcome).toBe("temp_password_expired");
    expect(d.createSession).toBe(false);
    expect(d.error?.code).toBe("temp_password_expired");
  });

  it("a valid temporary password signs in (the session is then restricted to changing it)", () => {
    const d = decideLogin(
      subject({ mustChangePassword: true, tempPasswordExpiresAt: later(mins(1)) }),
      ev(),
      NOW,
    );
    expect(d.outcome).toBe("success");
    expect(d.createSession).toBe(true);
  });

  describe("with MFA enabled", () => {
    const mfa = subject({ mfaEnabled: true, failedLoginCount: 2 });

    it("no code: mfa_required, no session, failure count untouched", () => {
      const d = decideLogin(mfa, ev(), NOW);
      expect(d.outcome).toBe("mfa_required");
      expect(d.createSession).toBe(false);
      expect(d.failedLoginCount).toBe(2);
      expect(d.error?.code).toBe("mfa_required");
    });

    it("wrong code: mfa_failed and counts towards the lockout", () => {
      const d = decideLogin(mfa, ev({ totpProvided: true, totpOk: false }), NOW);
      expect(d.outcome).toBe("mfa_failed");
      expect(d.createSession).toBe(false);
      expect(d.failedLoginCount).toBe(3);
    });

    it("wrong code at the threshold locks the account", () => {
      const d = decideLogin(
        subject({ mfaEnabled: true, failedLoginCount: LOCKOUT_THRESHOLD - 1 }),
        ev({ totpProvided: true, totpOk: false }),
        NOW,
      );
      expect(d.lockedNow).toBe(true);
    });

    it("right code: success with an MFA-verified session", () => {
      const d = decideLogin(mfa, ev({ totpProvided: true, totpOk: true }), NOW);
      expect(d.outcome).toBe("success");
      expect(d.createSession).toBe(true);
      expect(d.mfaVerified).toBe(true);
      expect(d.failedLoginCount).toBe(0);
    });

    it("valid recovery code: signs in and marks the code used", () => {
      const d = decideLogin(mfa, ev({ recoveryProvided: true, recoveryOk: true }), NOW);
      expect(d.outcome).toBe("mfa_recovery_code_used");
      expect(d.createSession).toBe(true);
      expect(d.mfaVerified).toBe(true);
      expect(d.useRecoveryCode).toBe(true);
    });

    it("used or wrong recovery code: mfa_failed", () => {
      const d = decideLogin(mfa, ev({ recoveryProvided: true, recoveryOk: false }), NOW);
      expect(d.outcome).toBe("mfa_failed");
      expect(d.createSession).toBe(false);
      expect(d.useRecoveryCode).toBe(false);
    });

    it("a wrong password never reaches the MFA step", () => {
      const d = decideLogin(mfa, ev({ passwordOk: false, totpProvided: true, totpOk: true }), NOW);
      expect(d.outcome).toBe("bad_password");
      expect(d.createSession).toBe(false);
    });
  });

  it("an Admin without MFA gets a session that is not MFA-verified (enrolment is then forced)", () => {
    const d = decideLogin(subject({ role: "admin2" }), ev(), NOW);
    expect(d.createSession).toBe(true);
    expect(d.mfaVerified).toBe(false);
  });
});

// ---------------------------------------------------------------- restrictions
describe("sessionRestrictions", () => {
  it("a normal subscriber session is unrestricted", () => {
    expect(sessionRestrictions({ role: "subscriber", mfaEnabled: false, mfaVerified: false, mustChangePassword: false })).toEqual([]);
  });
  it("Admin without MFA must enrol before doing anything else", () => {
    expect(sessionRestrictions({ role: "admin1", mfaEnabled: false, mfaVerified: false, mustChangePassword: false })).toEqual(["mfa_enrollment"]);
    expect(sessionRestrictions({ role: "super_admin", mfaEnabled: false, mfaVerified: false, mustChangePassword: false })).toEqual(["mfa_enrollment"]);
  });
  it("an MFA-verified session (e.g. the local auto-login) is not forced to enrol", () => {
    expect(sessionRestrictions({ role: "super_admin", mfaEnabled: false, mfaVerified: true, mustChangePassword: false })).toEqual([]);
  });
  it("a temporary password must be changed first", () => {
    expect(sessionRestrictions({ role: "subscriber", mfaEnabled: false, mfaVerified: false, mustChangePassword: true })).toEqual(["password_change"]);
  });
  it("both restrictions can apply, password first", () => {
    expect(sessionRestrictions({ role: "admin2", mfaEnabled: false, mfaVerified: false, mustChangePassword: true })).toEqual(["password_change", "mfa_enrollment"]);
  });
});

// ---------------------------------------------------------------- session validity
describe("checkSession", () => {
  const UID = "u1";
  const base = () => ({ userId: UID, endedAt: null as Date | null, expiresAt: later(SESSION_TTL_MS), lastSeenAt: ago(mins(1)), mfaVerifiedAt: null as Date | null });
  const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
    session: base(),
    claims: { sub: UID, sv: 1 },
    userSessionVersion: 1,
    role: "subscriber",
    lifecycleStatus: null,
    mfaEnabled: false,
    ...over,
  });

  it("an open session is valid and refreshes last_seen at most once a minute", () => {
    expect(checkSession(facts(), NOW)).toEqual({ valid: true, touch: false });
    expect(
      checkSession(facts({ session: { ...base(), lastSeenAt: ago(mins(2)) } }), NOW),
    ).toEqual({ valid: true, touch: true });
  });

  it("a missing session row is invalid (e.g. a forged sid)", () => {
    expect(checkSession(facts({ session: null }), NOW)).toEqual({ valid: false });
  });

  it("a revoked or logged-out session is invalid", () => {
    expect(checkSession(facts({ session: { ...base(), endedAt: ago(1) } }), NOW)).toEqual({ valid: false });
  });

  it("a session belonging to another user is invalid", () => {
    expect(checkSession(facts({ claims: { sub: "someone-else", sv: 1 } }), NOW)).toEqual({ valid: false });
  });

  it("'sign out everywhere' via session_version still invalidates", () => {
    expect(checkSession(facts({ userSessionVersion: 2 }), NOW)).toEqual({ valid: false });
  });

  it("an expired session is ended as timeout", () => {
    expect(checkSession(facts({ session: { ...base(), expiresAt: ago(1) } }), NOW)).toEqual({ valid: false, end: "timeout" });
  });

  it("Super Admin sessions end after 30 minutes idle", () => {
    expect(SUPER_ADMIN_IDLE_MS).toBe(mins(30));
    const idle = { ...base(), lastSeenAt: ago(mins(31)) };
    expect(checkSession(facts({ role: "super_admin", session: idle }), NOW)).toEqual({ valid: false, end: "timeout" });
    expect(checkSession(facts({ role: "admin1", session: idle }), NOW)).toEqual({ valid: true, touch: true });
  });

  it.each([
    ["suspended", "user_suspended"],
    ["disabled", "user_disabled"],
    ["left", "user_left"],
  ] as const)("a %s user's open session is ended (%s)", (status, reason) => {
    expect(checkSession(facts({ lifecycleStatus: status }), NOW)).toEqual({ valid: false, end: reason });
  });

  it("a session that never passed MFA ends once the user has MFA on", () => {
    expect(checkSession(facts({ mfaEnabled: true }), NOW)).toEqual({ valid: false, end: "revoked" });
    const verified = { ...base(), mfaVerifiedAt: ago(mins(5)) };
    expect(checkSession(facts({ mfaEnabled: true, session: verified }), NOW)).toEqual({ valid: true, touch: false });
  });
});

describe("policy constants", () => {
  it("temporary passwords last 72 hours and sessions 7 days", () => {
    expect(TEMP_PASSWORD_TTL_MS).toBe(72 * 3_600_000);
    expect(SESSION_TTL_MS).toBe(7 * 86_400_000);
  });
});

describe("validateRevokeReason", () => {
  it("requires 3 to 1000 meaningful characters", () => {
    expect(validateRevokeReason("lost laptop")).toBe("lost laptop");
    expect(validateRevokeReason("  phone stolen  ")).toBe("phone stolen");
    expect(validateRevokeReason("")).toBeNull();
    expect(validateRevokeReason("  a ")).toBeNull();
    expect(validateRevokeReason(undefined)).toBeNull();
    expect(validateRevokeReason("x".repeat(1001))).toBeNull();
  });
});

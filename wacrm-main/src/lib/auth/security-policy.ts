// ============================================================
// Sign-in and session security rules — pure, no I/O.
//
// Every decision about who may sign in, when a session stops being
// valid and what a session is restricted to lives here, so the rules are
// unit-tested in one place (security-policy.test.ts). The database layer
// (security-service.ts) only applies these decisions.
//
// Decisions (docs/user-module-assumptions.md, confirmed by the owner):
//   * admin1 and admin2 both have the Admin permission level.
//   * MFA is mandatory for Super Admin and Admin, optional for others.
//   * 5 consecutive failed attempts lock the account for 15 minutes.
//   * Temporary passwords last 72 hours.
//   * Sessions last 7 days; Super Admin sessions end after 30 minutes idle.
// ============================================================

import type { PlatformRole } from "@/lib/platform/access";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const TEMP_PASSWORD_TTL_MS = 72 * 3_600_000;
export const SESSION_TTL_MS = 7 * 86_400_000;
export const SUPER_ADMIN_IDLE_MS = 30 * 60_000;
/** last_seen_at is written at most this often per session. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
export const RECOVERY_CODE_COUNT = 10;

export type LifecycleStatus = "active" | "suspended" | "disabled" | "left";

// ---------------------------------------------------------------- roles

export type PermissionLevel = "super_admin" | "admin" | "user";

export function permissionLevel(role: PlatformRole | null | undefined): PermissionLevel {
  if (role === "super_admin") return "super_admin";
  if (role === "admin1" || role === "admin2") return "admin";
  return "user";
}

export function isMfaMandatory(role: PlatformRole | null | undefined): boolean {
  return permissionLevel(role) !== "user";
}

export function canDisableMfa(role: PlatformRole | null | undefined): boolean {
  return !isMfaMandatory(role);
}

/**
 * Super Admin: anyone except another Super Admin (those are managed in SQL).
 * Admin (admin1 or admin2): subscribers only.
 */
export function canIssueTempPassword(actor: PlatformRole, target: PlatformRole): boolean {
  if (target === "super_admin") return false;
  const level = permissionLevel(actor);
  if (level === "super_admin") return true;
  if (level === "admin") return target === "subscriber";
  return false;
}

// ---------------------------------------------------------------- login

/** Values of crm_auth_login_attempts.outcome. */
export type LoginOutcome =
  | "success"
  | "bad_password"
  | "unknown_user"
  | "locked"
  | "suspended"
  | "disabled"
  | "left"
  | "mfa_required"
  | "mfa_failed"
  | "mfa_recovery_code_used"
  | "temp_password_expired"
  | "rate_limited";

export interface LoginSubject {
  role: PlatformRole | null;
  lifecycleStatus: LifecycleStatus | null;
  mfaEnabled: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
}

export interface LoginEvidence {
  passwordOk: boolean;
  totpProvided: boolean;
  totpOk: boolean;
  recoveryProvided: boolean;
  recoveryOk: boolean;
}

export type LoginErrorCode =
  | "invalid_credentials"
  | "locked"
  | "account_inactive"
  | "temp_password_expired"
  | "mfa_required"
  | "mfa_failed";

export interface LoginDecision {
  outcome: LoginOutcome;
  createSession: boolean;
  /** The session satisfied MFA (code or recovery code). */
  mfaVerified: boolean;
  /** Values to store back on crm_user_auth_security. */
  failedLoginCount: number;
  lockedUntil: Date | null;
  /** This attempt triggered the lock (write an account_locked event). */
  lockedNow: boolean;
  /** Mark the presented recovery code as used. */
  useRecoveryCode: boolean;
  error?: { status: number; code: LoginErrorCode; message: string };
}

const INVALID = { status: 401, code: "invalid_credentials" as const, message: "Invalid login credentials" };
const lockedError = (until: Date, now: Date) => {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  return {
    status: 423,
    code: "locked" as const,
    message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  };
};

export function decideLogin(s: LoginSubject | null, ev: LoginEvidence, now: Date): LoginDecision {
  const base = { createSession: false, mfaVerified: false, lockedNow: false, useRecoveryCode: false };
  if (!s) {
    return { ...base, outcome: "unknown_user", failedLoginCount: 0, lockedUntil: null, error: INVALID };
  }

  if (s.lockedUntil && s.lockedUntil.getTime() > now.getTime()) {
    return {
      ...base,
      outcome: "locked",
      failedLoginCount: s.failedLoginCount,
      lockedUntil: s.lockedUntil,
      error: lockedError(s.lockedUntil, now),
    };
  }
  // A lock that has run out gives a fresh budget.
  const failures = s.lockedUntil ? 0 : s.failedLoginCount;

  const fail = (outcome: LoginOutcome, err: LoginDecision["error"]): LoginDecision => {
    const count = failures + 1;
    if (count >= LOCKOUT_THRESHOLD) {
      const until = new Date(now.getTime() + LOCKOUT_MS);
      return { ...base, outcome, failedLoginCount: 0, lockedUntil: until, lockedNow: true, error: lockedError(until, now) };
    }
    return { ...base, outcome, failedLoginCount: count, lockedUntil: null, error: err };
  };

  if (!ev.passwordOk) return fail("bad_password", INVALID);

  // Status is only revealed to someone who knows the password.
  if (s.lifecycleStatus && s.lifecycleStatus !== "active") {
    const msg =
      s.lifecycleStatus === "suspended"
        ? "This account is suspended. Contact your administrator."
        : s.lifecycleStatus === "disabled"
          ? "This account is disabled. Contact your administrator."
          : "This account is no longer active.";
    return {
      ...base,
      outcome: s.lifecycleStatus,
      failedLoginCount: failures,
      lockedUntil: null,
      error: { status: 403, code: "account_inactive", message: msg },
    };
  }

  if (s.mustChangePassword && s.tempPasswordExpiresAt && s.tempPasswordExpiresAt.getTime() <= now.getTime()) {
    return {
      ...base,
      outcome: "temp_password_expired",
      failedLoginCount: 0,
      lockedUntil: null,
      error: {
        status: 401,
        code: "temp_password_expired",
        message: "Your temporary password has expired. Ask an administrator for a new one.",
      },
    };
  }

  if (s.mfaEnabled) {
    if (ev.recoveryProvided) {
      if (!ev.recoveryOk) return fail("mfa_failed", { status: 401, code: "mfa_failed", message: "That recovery code is not valid." });
      return {
        ...base,
        outcome: "mfa_recovery_code_used",
        createSession: true,
        mfaVerified: true,
        useRecoveryCode: true,
        failedLoginCount: 0,
        lockedUntil: null,
      };
    }
    if (ev.totpProvided) {
      if (!ev.totpOk) return fail("mfa_failed", { status: 401, code: "mfa_failed", message: "That code is not valid. Check your authenticator app." });
      return { ...base, outcome: "success", createSession: true, mfaVerified: true, failedLoginCount: 0, lockedUntil: null };
    }
    return {
      ...base,
      outcome: "mfa_required",
      failedLoginCount: failures,
      lockedUntil: null,
      error: { status: 401, code: "mfa_required", message: "Enter the 6-digit code from your authenticator app." },
    };
  }

  return { ...base, outcome: "success", createSession: true, failedLoginCount: 0, lockedUntil: null };
}

// ---------------------------------------------------------------- sessions

export type SessionRestriction = "password_change" | "mfa_enrollment";

/** What a valid session must do before it may use the rest of the app. */
export function sessionRestrictions(x: {
  role: PlatformRole | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mustChangePassword: boolean;
}): SessionRestriction[] {
  const out: SessionRestriction[] = [];
  if (x.mustChangePassword) out.push("password_change");
  if (isMfaMandatory(x.role) && !x.mfaEnabled && !x.mfaVerified) out.push("mfa_enrollment");
  return out;
}

export type SessionEndReason =
  | "logout"
  | "timeout"
  | "revoked"
  | "revoked_all"
  | "password_changed"
  | "user_suspended"
  | "user_disabled"
  | "user_left";

export interface SessionFacts {
  session: {
    userId: string;
    endedAt: Date | null;
    expiresAt: Date;
    lastSeenAt: Date;
    mfaVerifiedAt: Date | null;
  } | null;
  claims: { sub: string; sv: number };
  userSessionVersion: number;
  role: PlatformRole | null;
  lifecycleStatus: LifecycleStatus | null;
  mfaEnabled: boolean;
}

export type SessionCheck = { valid: true; touch: boolean } | { valid: false; end?: SessionEndReason };

export function checkSession(f: SessionFacts, now: Date): SessionCheck {
  const s = f.session;
  if (!s || s.userId !== f.claims.sub || s.endedAt) return { valid: false };
  if (f.userSessionVersion !== f.claims.sv) return { valid: false };
  const t = now.getTime();
  if (s.expiresAt.getTime() <= t) return { valid: false, end: "timeout" };
  if (f.role === "super_admin" && t - s.lastSeenAt.getTime() > SUPER_ADMIN_IDLE_MS) {
    return { valid: false, end: "timeout" };
  }
  if (f.lifecycleStatus === "suspended") return { valid: false, end: "user_suspended" };
  if (f.lifecycleStatus === "disabled") return { valid: false, end: "user_disabled" };
  if (f.lifecycleStatus === "left") return { valid: false, end: "user_left" };
  if (f.mfaEnabled && !s.mfaVerifiedAt) return { valid: false, end: "revoked" };
  return { valid: true, touch: t - s.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS };
}

/** Reason for "sign out everywhere": trimmed, 3–1000 characters, else null. */
export function validateRevokeReason(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const r = input.trim();
  return r.length >= 3 && r.length <= 1000 ? r : null;
}

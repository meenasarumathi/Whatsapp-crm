// ============================================================
// Sign-in security service (Phase 1 of the User Management module).
//
// Applies the pure rules in ./security-policy to the database:
//   crm_auth_login_attempts  every attempt (append-only)
//   crm_auth_sessions        one row per signed-in device; the cookie's sid
//   crm_user_auth_security   lockout counters, MFA secret, temp password
//   crm_mfa_recovery_codes   SHA-256 of each one-time code
//   crm_user_events          audit trail (append-only)
//
// Server only; uses the owner connection (these tables have RLS on and no
// grants for the application role). Never logs or returns secrets except the
// values a user must see once (new TOTP secret, recovery codes, temporary
// password), and never writes them to the audit trail.
// ============================================================

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";

import { getPool } from "@/lib/db/pool";
import { isPlatformRole, type PlatformRole } from "@/lib/platform/access";
import { decrypt, encrypt } from "@/lib/whatsapp/encryption";
import { sendMail } from "./mailer";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password";
import { generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode } from "./recovery-codes";
import {
  canDisableMfa,
  canIssueTempPassword,
  checkSession,
  decideLogin,
  isMfaMandatory,
  LOCKOUT_THRESHOLD,
  SESSION_TTL_MS,
  sessionRestrictions,
  TEMP_PASSWORD_TTL_MS,
  validateRevokeReason,
  type LifecycleStatus,
  type LoginOutcome,
  type SessionEndReason,
  type SessionRestriction,
} from "./security-policy";
import { AuthError } from "./service";
import type { SessionClaims } from "./session-token";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

export const MFA_ISSUER = "Zyloop WACRM";

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const DUMMY_BCRYPT = "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
const inet = (ip: string | null | undefined) => (ip && isIP(ip) ? ip : null);
const ua = (s: string | null | undefined) => (s ? s.slice(0, 500) : null);
const toDate = (v: string | Date | null | undefined) => (v == null ? null : new Date(v));
const asRole = (r: unknown): PlatformRole | null => (isPlatformRole(r) ? r : null);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

type EventType =
  | "account_locked"
  | "session_revoked"
  | "all_sessions_revoked"
  | "mfa_enrolled"
  | "mfa_disabled"
  | "mfa_recovery_codes_regenerated"
  | "mfa_recovery_code_used"
  | "password_changed"
  | "password_reset_requested"
  | "password_reset_completed"
  | "temp_password_issued";

async function addEvent(
  c: PoolClient,
  e: {
    subject: string;
    actor: string | null;
    type: EventType;
    reason?: string | null;
    details?: Record<string, unknown>;
    ref?: { table: string; id: string };
    ip?: string | null;
  },
) {
  await c.query(
    `INSERT INTO public.crm_user_events (subject_user_id, actor_id, event_type, reason, details, ref_table, ref_id, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [e.subject, e.actor, e.type, e.reason ?? null, JSON.stringify(e.details ?? {}), e.ref?.table ?? null, e.ref?.id ?? null, inet(e.ip)],
  );
}

async function upsertSecurity(c: PoolClient, userId: string, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  const vals = Object.values(set);
  await c.query(
    `INSERT INTO public.crm_user_auth_security (user_id, ${cols.join(", ")})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})
     ON CONFLICT (user_id) DO UPDATE SET ${cols.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}`,
    [userId, ...vals],
  );
}

async function insertSession(c: PoolClient, userId: string, meta: RequestMeta, mfaVerified: boolean) {
  const r = await c.query<{ id: string; session_version: number }>(
    `WITH s AS (
       INSERT INTO public.crm_auth_sessions (user_id, expires_at, mfa_verified_at, ip_address, user_agent)
       VALUES ($1, now() + make_interval(secs => $2), CASE WHEN $3 THEN now() END, $4, $5)
       RETURNING id)
     SELECT s.id, u.session_version FROM s, public.users u WHERE u.id = $1`,
    [userId, SESSION_TTL_MS / 1000, mfaVerified, inet(meta.ip), ua(meta.userAgent)],
  );
  return { sessionId: r.rows[0].id, sessionVersion: r.rows[0].session_version };
}

/** Ends open sessions of a user (optionally keeping one). Returns how many ended. */
async function endSessions(
  c: PoolClient,
  userId: string,
  reason: SessionEndReason,
  opts: { keep?: string | null; revokedBy?: string | null; onlyWithoutMfa?: boolean } = {},
): Promise<number> {
  const r = await c.query(
    `UPDATE public.crm_auth_sessions SET ended_at = now(), end_reason = $2, revoked_by = $3
      WHERE user_id = $1 AND ended_at IS NULL
        AND ($4::uuid IS NULL OR id <> $4::uuid)
        AND (NOT $5 OR mfa_verified_at IS NULL)`,
    [userId, reason, opts.revokedBy ?? null, opts.keep ?? null, !!opts.onlyWithoutMfa],
  );
  return r.rowCount ?? 0;
}

async function recordAttempt(
  c: PoolClient | null,
  a: { userId: string | null; email: string; outcome: LoginOutcome; sessionId?: string | null; meta: RequestMeta },
) {
  const run = c ?? getPool();
  await run.query(
    `INSERT INTO public.crm_auth_login_attempts (user_id, attempted_email, outcome, session_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [a.userId, a.email.slice(0, 320), a.outcome, a.sessionId ?? null, inet(a.meta.ip), ua(a.meta.userAgent)],
  );
}

/** For the login route's rate limiter: log the throttled attempt (no user lookup). */
export async function recordRateLimitedAttempt(email: unknown, meta: RequestMeta): Promise<void> {
  await recordAttempt(null, { userId: null, email: normEmail(email), outcome: "rate_limited", meta }).catch(() => {});
}

// ================================================================= sign-in

export interface SignInInput {
  email: unknown;
  password: unknown;
  code?: unknown;
  recoveryCode?: unknown;
}

export interface SignInResult {
  userId: string;
  email: string;
  sessionId: string;
  sessionVersion: number;
  restrictions: SessionRestriction[];
}

interface SubjectRow {
  id: string;
  email: string;
  password_hash: string | null;
  platform_role: string | null;
  lifecycle_status: LifecycleStatus | null;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  failed_login_count: number;
  locked_until: string | null;
  must_change_password: boolean;
  temp_password_expires_at: string | null;
}

export async function signInSecure(input: SignInInput, meta: RequestMeta, now: Date = new Date()): Promise<SignInResult> {
  const email = normEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const code = typeof input.code === "string" && input.code.trim() ? input.code : null;
  const recovery = input.recoveryCode == null || input.recoveryCode === "" ? null : input.recoveryCode;

  const result = await tx(async (c) => {
    // Lock the user row: concurrent attempts for one account are applied one at a time.
    const { rows } = await c.query<SubjectRow>(
      `SELECT u.id, u.email, u.password_hash, pu.platform_role, cp.lifecycle_status,
              coalesce(s.mfa_enabled, false) AS mfa_enabled, s.mfa_secret_enc,
              coalesce(s.failed_login_count, 0) AS failed_login_count, s.locked_until,
              coalesce(s.must_change_password, false) AS must_change_password, s.temp_password_expires_at
         FROM public.users u
         LEFT JOIN public.platform_users pu ON pu.user_id = u.id
         LEFT JOIN public.crm_user_profiles cp ON cp.user_id = u.id
         LEFT JOIN public.crm_user_auth_security s ON s.user_id = u.id
        WHERE lower(u.email) = $1
        FOR UPDATE OF u`,
      [email],
    );
    const row = rows[0];
    // Same bcrypt work whether or not the email exists.
    const passwordOk = await verifyPassword(password, row?.password_hash ?? DUMMY_BCRYPT);

    let totpOk = false;
    let recoveryId: string | null = null;
    if (row && passwordOk && row.mfa_enabled && row.mfa_secret_enc) {
      if (recovery != null) {
        const n = normaliseRecoveryCode(recovery);
        if (n) {
          const r = await c.query<{ id: string }>(
            `SELECT id FROM public.crm_mfa_recovery_codes
              WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
            [row.id, hashRecoveryCode(n)],
          );
          recoveryId = r.rows[0]?.id ?? null;
        }
      } else if (code) {
        totpOk = verifyTotp(decrypt(row.mfa_secret_enc), code, now);
      }
    }

    const role = asRole(row?.platform_role);
    const subject = row
      ? {
          role,
          lifecycleStatus: row.lifecycle_status,
          mfaEnabled: row.mfa_enabled,
          failedLoginCount: row.failed_login_count,
          lockedUntil: toDate(row.locked_until),
          mustChangePassword: row.must_change_password,
          tempPasswordExpiresAt: toDate(row.temp_password_expires_at),
        }
      : null;
    const d = decideLogin(
      subject,
      {
        passwordOk,
        totpProvided: recovery == null && !!code,
        totpOk,
        recoveryProvided: recovery != null,
        recoveryOk: !!recoveryId,
      },
      now,
    );

    if (row && subject) {
      const changed =
        d.failedLoginCount !== subject.failedLoginCount ||
        (d.lockedUntil?.getTime() ?? null) !== (subject.lockedUntil?.getTime() ?? null);
      if (changed) await upsertSecurity(c, row.id, { failed_login_count: d.failedLoginCount, locked_until: d.lockedUntil });
      if (d.lockedNow) {
        await addEvent(c, {
          subject: row.id,
          actor: null,
          type: "account_locked",
          details: { failed_attempts: LOCKOUT_THRESHOLD, locked_until: d.lockedUntil?.toISOString() },
          ip: meta.ip,
        });
      }
    }

    let session: { sessionId: string; sessionVersion: number } | null = null;
    if (row && d.createSession) {
      session = await insertSession(c, row.id, meta, d.mfaVerified);
      await c.query("UPDATE public.users SET last_sign_in_at = now() WHERE id = $1", [row.id]);
      if (d.useRecoveryCode && recoveryId) {
        await c.query("UPDATE public.crm_mfa_recovery_codes SET used_at = now() WHERE id = $1", [recoveryId]);
        await addEvent(c, { subject: row.id, actor: row.id, type: "mfa_recovery_code_used", ip: meta.ip });
      }
    }

    await recordAttempt(c, { userId: row?.id ?? null, email, outcome: d.outcome, sessionId: session?.sessionId, meta });

    return { d, row, role, session };
  });

  const { d, row, role, session } = result;
  if (d.error || !row || !session) {
    const e = d.error ?? { message: "Invalid login credentials", status: 401, code: "invalid_credentials" };
    throw new AuthError(e.message, e.status, e.code);
  }
  return {
    userId: row.id,
    email: row.email,
    sessionId: session.sessionId,
    sessionVersion: session.sessionVersion,
    restrictions: sessionRestrictions({
      role,
      mfaEnabled: row.mfa_enabled,
      mfaVerified: d.mfaVerified,
      mustChangePassword: row.must_change_password,
    }),
  };
}

/** A session for sign-up, password reset or the local auto-login. */
export async function createSession(
  userId: string,
  meta: RequestMeta,
  opts: { mfaVerified: boolean },
): Promise<{ sessionId: string; sessionVersion: number }> {
  return tx((c) => insertSession(c, userId, meta, opts.mfaVerified));
}

// ================================================================= per-request check

export interface ResolvedSession {
  user: { id: string; email: string; raw_user_meta_data: Record<string, unknown> | null; created_at: string };
  sessionId: string;
  role: PlatformRole | null;
  restrictions: SessionRestriction[];
}

export async function resolveSession(claims: SessionClaims, now: Date = new Date()): Promise<ResolvedSession | null> {
  if (!UUID_RE.test(claims.sub) || !UUID_RE.test(claims.sid)) return null;
  const { rows } = await getPool().query<{
    id: string;
    email: string;
    raw_user_meta_data: Record<string, unknown> | null;
    created_at: string;
    session_version: number;
    s_user: string | null;
    ended_at: string | null;
    expires_at: string | null;
    last_seen_at: string | null;
    mfa_verified_at: string | null;
    platform_role: string | null;
    lifecycle_status: LifecycleStatus | null;
    mfa_enabled: boolean;
    must_change_password: boolean;
  }>(
    `SELECT u.id, u.email, u.raw_user_meta_data, u.created_at, u.session_version,
            s.user_id AS s_user, s.ended_at, s.expires_at, s.last_seen_at, s.mfa_verified_at,
            pu.platform_role, cp.lifecycle_status,
            coalesce(sec.mfa_enabled, false) AS mfa_enabled,
            coalesce(sec.must_change_password, false) AS must_change_password
       FROM public.users u
       LEFT JOIN public.crm_auth_sessions s ON s.id = $2
       LEFT JOIN public.platform_users pu ON pu.user_id = u.id
       LEFT JOIN public.crm_user_profiles cp ON cp.user_id = u.id
       LEFT JOIN public.crm_user_auth_security sec ON sec.user_id = u.id
      WHERE u.id = $1`,
    [claims.sub, claims.sid],
  );
  const r = rows[0];
  if (!r) return null;
  const role = asRole(r.platform_role);
  const check = checkSession(
    {
      session: r.s_user
        ? {
            userId: r.s_user,
            endedAt: toDate(r.ended_at),
            expiresAt: toDate(r.expires_at)!,
            lastSeenAt: toDate(r.last_seen_at)!,
            mfaVerifiedAt: toDate(r.mfa_verified_at),
          }
        : null,
      claims: { sub: claims.sub, sv: claims.sv },
      userSessionVersion: r.session_version,
      role,
      lifecycleStatus: r.lifecycle_status,
      mfaEnabled: r.mfa_enabled,
    },
    now,
  );
  if (!check.valid) {
    if (check.end) {
      await getPool().query(
        "UPDATE public.crm_auth_sessions SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL",
        [claims.sid, check.end],
      );
    }
    return null;
  }
  if (check.touch) {
    await getPool().query("UPDATE public.crm_auth_sessions SET last_seen_at = now() WHERE id = $1 AND ended_at IS NULL", [claims.sid]);
  }
  return {
    user: { id: r.id, email: r.email, raw_user_meta_data: r.raw_user_meta_data, created_at: r.created_at },
    sessionId: claims.sid,
    role,
    restrictions: sessionRestrictions({
      role,
      mfaEnabled: r.mfa_enabled,
      mfaVerified: !!r.mfa_verified_at,
      mustChangePassword: r.must_change_password,
    }),
  };
}

// ================================================================= sessions

export async function logoutSession(userId: string, sessionId: string): Promise<void> {
  await getPool().query(
    "UPDATE public.crm_auth_sessions SET ended_at = now(), end_reason = 'logout' WHERE id = $1 AND user_id = $2 AND ended_at IS NULL",
    [sessionId, userId],
  );
}

export interface SessionListItem {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
}

export async function listSessions(userId: string, currentSessionId: string | null): Promise<SessionListItem[]> {
  const { rows } = await getPool().query<Omit<SessionListItem, "current">>(
    `SELECT id, created_at, last_seen_at, expires_at, host(ip_address) AS ip_address, user_agent
       FROM public.crm_auth_sessions
      WHERE user_id = $1 AND ended_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

/** Ends one of the user's own sessions. */
export async function revokeSession(x: { actorId: string; userId: string; sessionId: string; meta: RequestMeta }): Promise<void> {
  if (!UUID_RE.test(x.sessionId)) throw new AuthError("Session not found", 404, "not_found");
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE public.crm_auth_sessions SET ended_at = now(), end_reason = 'revoked', revoked_by = $3
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [x.sessionId, x.userId, x.actorId],
    );
    if (!r.rowCount) throw new AuthError("Session not found", 404, "not_found");
    await addEvent(c, {
      subject: x.userId,
      actor: x.actorId,
      type: "session_revoked",
      ref: { table: "crm_auth_sessions", id: x.sessionId },
      ip: x.meta.ip,
    });
  });
}

/** "Sign out everywhere": ends every open session (including the caller's) with a reason. */
export async function revokeAllSessions(x: { actorId: string; userId: string; reason: unknown; meta: RequestMeta }): Promise<number> {
  const reason = validateRevokeReason(x.reason);
  if (!reason) throw new AuthError("Give a reason (at least 3 characters)", 400, "reason_required");
  return tx(async (c) => {
    const n = await endSessions(c, x.userId, "revoked_all", { revokedBy: x.actorId });
    await c.query("UPDATE public.users SET session_version = session_version + 1 WHERE id = $1", [x.userId]);
    await addEvent(c, {
      subject: x.userId,
      actor: x.actorId,
      type: "all_sessions_revoked",
      reason,
      details: { sessions_ended: n },
      ip: x.meta.ip,
    });
    return n;
  });
}

// ================================================================= MFA

interface SecRow {
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
}
async function lockSecurity(c: PoolClient, userId: string): Promise<SecRow> {
  await c.query("INSERT INTO public.crm_user_auth_security (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
  const r = await c.query<SecRow>(
    "SELECT mfa_enabled, mfa_secret_enc FROM public.crm_user_auth_security WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  return r.rows[0];
}

async function replaceRecoveryCodes(c: PoolClient, userId: string): Promise<string[]> {
  await c.query(
    "UPDATE public.crm_mfa_recovery_codes SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
    [userId],
  );
  const codes = generateRecoveryCodes();
  const batch = randomUUID();
  await c.query(
    `INSERT INTO public.crm_mfa_recovery_codes (user_id, batch_id, code_hash)
     SELECT $1, $2, unnest($3::text[])`,
    [userId, batch, codes.map(hashRecoveryCode)],
  );
  return codes;
}

export interface MfaStatus {
  enabled: boolean;
  mandatory: boolean;
  canDisable: boolean;
  enrollmentPending: boolean;
  recoveryCodesLeft: number;
}

export async function getMfaStatus(userId: string, role: PlatformRole | null): Promise<MfaStatus> {
  const { rows } = await getPool().query<{ enabled: boolean; pending: boolean; left: string }>(
    `SELECT coalesce(s.mfa_enabled, false) AS enabled,
            (s.mfa_secret_enc IS NOT NULL AND NOT coalesce(s.mfa_enabled, false)) AS pending,
            (SELECT count(*) FROM public.crm_mfa_recovery_codes r
              WHERE r.user_id = $1 AND r.used_at IS NULL AND r.revoked_at IS NULL) AS left
       FROM (SELECT 1) one
       LEFT JOIN public.crm_user_auth_security s ON s.user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return {
    enabled: !!r?.enabled,
    mandatory: isMfaMandatory(role),
    canDisable: canDisableMfa(role),
    enrollmentPending: !!r?.pending,
    recoveryCodesLeft: Number(r?.left ?? 0),
  };
}

/** Step 1: a new secret (shown once, stored encrypted, not active until confirmed). */
export async function startMfaEnrollment(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
  return tx(async (c) => {
    const s = await lockSecurity(c, userId);
    if (s.mfa_enabled) throw new AuthError("Two-step verification is already on", 409, "mfa_already_enabled");
    const secret = generateTotpSecret();
    await c.query(
      "UPDATE public.crm_user_auth_security SET mfa_secret_enc = $2, mfa_enrolled_at = NULL WHERE user_id = $1",
      [userId, encrypt(secret)],
    );
    return { secret, otpauthUri: otpauthUri(secret, email, MFA_ISSUER) };
  });
}

/** Step 2: the first code turns MFA on, returns recovery codes, and ends other sessions that never passed MFA. */
export async function confirmMfaEnrollment(x: {
  userId: string;
  sessionId: string;
  code: unknown;
  meta: RequestMeta;
}): Promise<{ recoveryCodes: string[] }> {
  return tx(async (c) => {
    const s = await lockSecurity(c, x.userId);
    if (s.mfa_enabled) throw new AuthError("Two-step verification is already on", 409, "mfa_already_enabled");
    if (!s.mfa_secret_enc) throw new AuthError("Start setup again", 400, "mfa_not_started");
    if (!verifyTotp(decrypt(s.mfa_secret_enc), x.code)) {
      throw new AuthError("That code is not valid. Check the time on your phone and try again.", 400, "mfa_failed");
    }
    await c.query(
      "UPDATE public.crm_user_auth_security SET mfa_enabled = true, mfa_enrolled_at = now() WHERE user_id = $1",
      [x.userId],
    );
    const recoveryCodes = await replaceRecoveryCodes(c, x.userId);
    await c.query(
      "UPDATE public.crm_auth_sessions SET mfa_verified_at = now() WHERE id = $1 AND user_id = $2 AND ended_at IS NULL",
      [x.sessionId, x.userId],
    );
    await endSessions(c, x.userId, "revoked", { keep: x.sessionId, onlyWithoutMfa: true });
    await addEvent(c, { subject: x.userId, actor: x.userId, type: "mfa_enrolled", ip: x.meta.ip });
    return { recoveryCodes };
  });
}

async function verifyCurrentCode(c: PoolClient, userId: string, code: unknown): Promise<void> {
  const s = await lockSecurity(c, userId);
  if (!s.mfa_enabled || !s.mfa_secret_enc) throw new AuthError("Two-step verification is not on", 409, "mfa_not_enabled");
  if (!verifyTotp(decrypt(s.mfa_secret_enc), code)) throw new AuthError("That code is not valid.", 400, "mfa_failed");
}

export async function disableMfa(x: {
  userId: string;
  role: PlatformRole | null;
  password: unknown;
  code: unknown;
  meta: RequestMeta;
}): Promise<void> {
  if (!canDisableMfa(x.role)) {
    throw new AuthError("Two-step verification is required for administrators", 403, "forbidden");
  }
  await tx(async (c) => {
    const u = await c.query<{ password_hash: string | null }>("SELECT password_hash FROM public.users WHERE id = $1", [x.userId]);
    if (!(await verifyPassword(typeof x.password === "string" ? x.password : "", u.rows[0]?.password_hash))) {
      throw new AuthError("Current password is incorrect", 403, "wrong_password");
    }
    await verifyCurrentCode(c, x.userId, x.code);
    await c.query(
      "UPDATE public.crm_user_auth_security SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_enrolled_at = NULL WHERE user_id = $1",
      [x.userId],
    );
    await c.query(
      "UPDATE public.crm_mfa_recovery_codes SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
      [x.userId],
    );
    await addEvent(c, { subject: x.userId, actor: x.userId, type: "mfa_disabled", ip: x.meta.ip });
  });
}

export async function regenerateRecoveryCodes(x: { userId: string; code: unknown; meta: RequestMeta }): Promise<string[]> {
  return tx(async (c) => {
    await verifyCurrentCode(c, x.userId, x.code);
    const codes = await replaceRecoveryCodes(c, x.userId);
    await addEvent(c, { subject: x.userId, actor: x.userId, type: "mfa_recovery_codes_regenerated", ip: x.meta.ip });
    return codes;
  });
}

// ================================================================= passwords

const TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function generateTempPassword(length = 16): string {
  let s = "";
  for (let i = 0; i < length; i++) s += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return s;
}

/**
 * An administrator sets a one-off password (72h) that must be changed at the
 * next sign-in. The target's open sessions end. The actor's role is read from
 * the database here, never taken from the request.
 */
export async function issueTemporaryPassword(x: {
  actorId: string;
  targetUserId: string;
  meta: RequestMeta;
}): Promise<{ password: string; expiresAt: string }> {
  if (x.actorId === x.targetUserId || !UUID_RE.test(x.targetUserId)) {
    throw new AuthError("You cannot issue a temporary password for this user", 403, "forbidden");
  }
  const password = generateTempPassword();
  const hash = await hashPassword(password);
  return tx(async (c) => {
    const roles = await c.query<{ id: string; platform_role: string | null }>(
      `SELECT u.id, pu.platform_role FROM public.users u
         LEFT JOIN public.platform_users pu ON pu.user_id = u.id
        WHERE u.id = ANY($1::uuid[])`,
      [[x.actorId, x.targetUserId]],
    );
    const actorRole = asRole(roles.rows.find((r) => r.id === x.actorId)?.platform_role);
    const target = roles.rows.find((r) => r.id === x.targetUserId);
    if (!target) throw new AuthError("User not found", 404, "not_found");
    const targetRole = asRole(target.platform_role) ?? "subscriber";
    if (!actorRole || !canIssueTempPassword(actorRole, targetRole)) {
      throw new AuthError("You cannot issue a temporary password for this user", 403, "forbidden");
    }
    const exp = await c.query<{ expires_at: string }>(
      "SELECT now() + make_interval(secs => $1) AS expires_at",
      [TEMP_PASSWORD_TTL_MS / 1000],
    );
    const expiresAt = exp.rows[0].expires_at;
    await c.query("UPDATE public.users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1", [
      x.targetUserId,
      hash,
    ]);
    await upsertSecurity(c, x.targetUserId, {
      must_change_password: true,
      temp_password_expires_at: expiresAt,
      failed_login_count: 0,
      locked_until: null,
    });
    const ended = await endSessions(c, x.targetUserId, "revoked", { revokedBy: x.actorId });
    await addEvent(c, {
      subject: x.targetUserId,
      actor: x.actorId,
      type: "temp_password_issued",
      details: { expires_at: expiresAt, sessions_ended: ended },
      ip: x.meta.ip,
    });
    return { password, expiresAt };
  });
}

function checkNewPassword(next: unknown): string {
  if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400, "weak_password");
  }
  return next;
}

/** Change own password: clears a temporary-password restriction and ends the user's other sessions. */
export async function changePasswordSecure(x: {
  userId: string;
  sessionId: string;
  current: unknown;
  next: unknown;
  meta: RequestMeta;
}): Promise<void> {
  const next = checkNewPassword(x.next);
  const hash = await hashPassword(next);
  await tx(async (c) => {
    const u = await c.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM public.users WHERE id = $1 FOR UPDATE",
      [x.userId],
    );
    if (!(await verifyPassword(typeof x.current === "string" ? x.current : "", u.rows[0]?.password_hash))) {
      throw new AuthError("Current password is incorrect", 403, "wrong_password");
    }
    if (typeof x.current === "string" && x.current === next) {
      throw new AuthError("Choose a password different from the current one", 400, "same_password");
    }
    await c.query("UPDATE public.users SET password_hash = $2 WHERE id = $1", [x.userId, hash]);
    await upsertSecurity(c, x.userId, {
      must_change_password: false,
      temp_password_expires_at: null,
      password_changed_at: new Date(),
    });
    const ended = await endSessions(c, x.userId, "password_changed", { keep: x.sessionId });
    await addEvent(c, {
      subject: x.userId,
      actor: x.userId,
      type: "password_changed",
      details: { other_sessions_ended: ended },
      ip: x.meta.ip,
    });
  });
}

export async function requestPasswordResetSecure(emailIn: unknown, origin: string, meta: RequestMeta): Promise<void> {
  const email = normEmail(emailIn);
  const { rows } = await getPool().query<{ id: string }>("SELECT id FROM public.users WHERE lower(email) = $1", [email]);
  if (!rows[0]) return; // never reveal whether an address is registered
  const token = randomBytes(32).toString("base64url");
  await tx(async (c) => {
    await c.query(
      `INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [rows[0].id, sha256(token), inet(meta.ip)],
    );
    await addEvent(c, { subject: rows[0].id, actor: null, type: "password_reset_requested", ip: meta.ip });
  });
  const link = `${origin}/reset-password?token=${token}`;
  await sendMail(
    email,
    "Reset your password",
    `Use this link within one hour to choose a new password:\n\n${link}\n\nIf you did not ask for this, ignore this message.`,
  );
}

/**
 * Completes a reset: new password, every session ended, lockout and any
 * temporary password cleared. Returns a new session unless the user has MFA
 * on (then they sign in normally, with their code).
 */
export async function resetPasswordSecure(x: {
  token: unknown;
  password: unknown;
  meta: RequestMeta;
}): Promise<{ userId: string; session: { sessionId: string; sessionVersion: number } | null }> {
  if (typeof x.token !== "string" || !x.token) throw new AuthError("Reset link is invalid or has expired", 400, "invalid_token");
  const next = checkNewPassword(x.password);
  const hash = await hashPassword(next);
  return tx(async (c) => {
    const t = await c.query<{ user_id: string }>(
      `SELECT user_id FROM public.password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(x.token as string)],
    );
    const userId = t.rows[0]?.user_id;
    if (!userId) throw new AuthError("Reset link is invalid or has expired", 400, "invalid_token");
    await c.query("UPDATE public.users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1", [userId, hash]);
    await c.query("UPDATE public.password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
    await endSessions(c, userId, "password_changed");
    await upsertSecurity(c, userId, {
      must_change_password: false,
      temp_password_expires_at: null,
      failed_login_count: 0,
      locked_until: null,
      password_changed_at: new Date(),
    });
    await addEvent(c, { subject: userId, actor: userId, type: "password_reset_completed", ip: x.meta.ip });
    const mfa = await c.query<{ mfa_enabled: boolean }>(
      "SELECT mfa_enabled FROM public.crm_user_auth_security WHERE user_id = $1",
      [userId],
    );
    const session = mfa.rows[0]?.mfa_enabled ? null : await insertSession(c, userId, x.meta, false);
    return { userId, session };
  });
}

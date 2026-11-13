/**
 * Phase 1 acceptance tests against REAL PostgreSQL (sign-in, lockout,
 * sessions, MFA, recovery codes, temporary passwords, password reset).
 *
 * Opt-in, because they need a Postgres server and psql on PATH:
 *   USER_MODULE_TEST_PG=1 npx vitest run src/lib/auth/security-service.db.test.ts
 * Optional: USER_MODULE_PG_URL — a connection to the server's maintenance
 * database (default postgresql://postgres@127.0.0.1:55432/postgres).
 *
 * The database `wacrm_user_module_test` is dropped, re-created from
 * db/schema.sql and dropped again at the end; nothing else is touched.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENABLED = process.env.USER_MODULE_TEST_PG === "1";
const ADMIN_URL = process.env.USER_MODULE_PG_URL ?? "postgresql://postgres@127.0.0.1:55432/postgres";
const DB = "wacrm_user_module_test";
const testUrl = () => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${DB}`;
  return u.toString();
};

vi.mock("./mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

type Svc = typeof import("./security-service");
type Totp = typeof import("./totp");
let svc: Svc;
let totp: Totp;
let db: pg.Pool;

const META = { ip: "203.0.113.7", userAgent: "vitest" };
const PASSWORD = "correct-horse-battery";

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return (await db.query<T>(text, params)).rows;
}
async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return (await q<T>(text, params))[0];
}

let seq = 0;
/** A fresh user with a known password and the given platform role. */
async function makeUser(role: "super_admin" | "admin1" | "admin2" | "subscriber" = "subscriber") {
  const { hashPassword } = await import("./password");
  const email = `u${++seq}-${Date.now()}@test.local`;
  const u = await one<{ id: string }>(
    "INSERT INTO public.users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, await hashPassword(PASSWORD)],
  );
  await db.query("ALTER TABLE public.platform_users DISABLE TRIGGER crm_platform_users_last_super_admin");
  await db.query(
    `INSERT INTO public.platform_users (user_id, platform_role, subscription_status) VALUES ($1, $2, 'active')
     ON CONFLICT (user_id) DO UPDATE SET platform_role = EXCLUDED.platform_role, subscription_status = 'active'`,
    [u.id, role],
  );
  await db.query("ALTER TABLE public.platform_users ENABLE TRIGGER crm_platform_users_last_super_admin");
  return { id: u.id, email };
}

async function expectAuthError(p: Promise<unknown>, code: string, status?: number) {
  const { AuthError } = await import("./service");
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError);
    expect((e as InstanceType<typeof AuthError>).code).toBe(code);
    if (status) expect((e as InstanceType<typeof AuthError>).status).toBe(status);
    return;
  }
  throw new Error(`expected AuthError ${code}, but the call succeeded`);
}

const attempts = (userId: string) =>
  q<{ outcome: string; session_id: string | null; ip_address: string | null }>(
    "SELECT outcome, session_id, host(ip_address) AS ip_address FROM public.crm_auth_login_attempts WHERE user_id = $1 ORDER BY occurred_at, id",
    [userId],
  );
const openSessions = async (userId: string) =>
  Number((await one<{ n: string }>("SELECT count(*) n FROM public.crm_auth_sessions WHERE user_id = $1 AND ended_at IS NULL", [userId])).n);
const events = (userId: string, type: string) =>
  q<{ reason: string | null; actor_id: string | null; details: Record<string, unknown> }>(
    "SELECT reason, actor_id, details FROM public.crm_user_events WHERE subject_user_id = $1 AND event_type = $2",
    [userId, type],
  );

describe.skipIf(!ENABLED)("Phase 1 security service (real Postgres)", () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    execFileSync("psql", [testUrl(), "-q", "-v", "ON_ERROR_STOP=0", "-f", join(process.cwd(), "db/schema.sql")], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
    });
    process.env.DATABASE_URL = testUrl();
    process.env.AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars-long";
    db = new pg.Pool({ connectionString: testUrl(), max: 3 });
    svc = await import("./security-service");
    totp = await import("./totp");
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;
    const { closePool } = await import("@/lib/db/pool");
    await closePool();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(() => vi.clearAllMocks());

  // ------------------------------------------------------------ acceptance 1
  it("a wrong password writes an attempt with no session", async () => {
    const u = await makeUser();
    await expectAuthError(svc.signInSecure({ email: u.email, password: "nope" }, META), "invalid_credentials", 401);
    expect(await attempts(u.id)).toEqual([{ outcome: "bad_password", session_id: null, ip_address: "203.0.113.7" }]);
    expect(await openSessions(u.id)).toBe(0);
  });

  it("an unknown email is logged without a user and gives the same error", async () => {
    await expectAuthError(svc.signInSecure({ email: "ghost@test.local", password: "x" }, META), "invalid_credentials", 401);
    const row = await one<{ outcome: string; user_id: string | null }>(
      "SELECT outcome, user_id FROM public.crm_auth_login_attempts WHERE attempted_email = 'ghost@test.local'",
    );
    expect(row).toEqual({ outcome: "unknown_user", user_id: null });
  });

  it("a correct password creates a session row and a success attempt linked to it", async () => {
    const u = await makeUser();
    const r = await svc.signInSecure({ email: u.email.toUpperCase(), password: PASSWORD }, META);
    expect(r.userId).toBe(u.id);
    expect(r.restrictions).toEqual([]);
    const s = await one<{ id: string; ip: string; ua: string; expires_in_days: number }>(
      "SELECT id, host(ip_address) ip, user_agent ua, round(extract(epoch FROM expires_at - created_at) / 86400) expires_in_days FROM public.crm_auth_sessions WHERE user_id = $1",
      [u.id],
    );
    expect(s).toEqual({ id: r.sessionId, ip: "203.0.113.7", ua: "vitest", expires_in_days: 7 });
    expect(await attempts(u.id)).toEqual([{ outcome: "success", session_id: r.sessionId, ip_address: "203.0.113.7" }]);
  });

  // ------------------------------------------------------------ acceptance 2
  it("the 6th failure returns 'locked' and account_locked is written once", async () => {
    const u = await makeUser();
    for (let i = 1; i <= 4; i++) {
      await expectAuthError(svc.signInSecure({ email: u.email, password: "wrong" }, META), "invalid_credentials");
    }
    await expectAuthError(svc.signInSecure({ email: u.email, password: "wrong" }, META), "locked", 423); // 5th locks
    await expectAuthError(svc.signInSecure({ email: u.email, password: PASSWORD }, META), "locked", 423); // 6th, even correct
    const outcomes = (await attempts(u.id)).map((a) => a.outcome);
    expect(outcomes).toEqual(["bad_password", "bad_password", "bad_password", "bad_password", "bad_password", "locked"]);
    expect(await events(u.id, "account_locked")).toHaveLength(1);
    expect(await openSessions(u.id)).toBe(0);

    // once the lock has passed, the right password works again
    await db.query("UPDATE public.crm_user_auth_security SET locked_until = now() - interval '1 second' WHERE user_id = $1", [u.id]);
    const ok = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
    expect(ok.sessionId).toBeTruthy();
  });

  // ------------------------------------------------------------ acceptance 3
  it("a revoked session is rejected on the next request", async () => {
    const u = await makeUser();
    const a = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
    const b = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
    const claimsA = { sub: u.id, sv: a.sessionVersion, sid: a.sessionId };
    expect(await svc.resolveSession(claimsA)).not.toBeNull();

    const list = await svc.listSessions(u.id, b.sessionId);
    expect(list.map((s) => s.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
    expect(list.find((s) => s.id === b.sessionId)?.current).toBe(true);

    await svc.revokeSession({ actorId: u.id, userId: u.id, sessionId: a.sessionId, meta: META });
    expect(await svc.resolveSession(claimsA)).toBeNull();
    expect(await svc.resolveSession({ sub: u.id, sv: b.sessionVersion, sid: b.sessionId })).not.toBeNull();
    expect(await events(u.id, "session_revoked")).toHaveLength(1);
    const ended = await one<{ end_reason: string; revoked_by: string }>("SELECT end_reason, revoked_by FROM public.crm_auth_sessions WHERE id = $1", [a.sessionId]);
    expect(ended).toEqual({ end_reason: "revoked", revoked_by: u.id });
  });

  it("a user cannot revoke someone else's session", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const s = await svc.signInSecure({ email: owner.email, password: PASSWORD }, META);
    await expectAuthError(svc.revokeSession({ actorId: other.id, userId: other.id, sessionId: s.sessionId, meta: META }), "not_found", 404);
    expect(await svc.resolveSession({ sub: owner.id, sv: s.sessionVersion, sid: s.sessionId })).not.toBeNull();
  });

  it("logout ends only the current session", async () => {
    const u = await makeUser();
    const a = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
    const b = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
    await svc.logoutSession(u.id, a.sessionId);
    expect(await svc.resolveSession({ sub: u.id, sv: a.sessionVersion, sid: a.sessionId })).toBeNull();
    expect(await svc.resolveSession({ sub: u.id, sv: b.sessionVersion, sid: b.sessionId })).not.toBeNull();
    expect((await one<{ end_reason: string }>("SELECT end_reason FROM public.crm_auth_sessions WHERE id = $1", [a.sessionId])).end_reason).toBe("logout");
  });

  // ------------------------------------------------------------ acceptance 4
  it("sign out everywhere ends every open session and records the reason", async () => {
    const u = await makeUser();
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push(await svc.signInSecure({ email: u.email, password: PASSWORD }, META));
    await expectAuthError(svc.revokeAllSessions({ actorId: u.id, userId: u.id, reason: " ", meta: META }), "reason_required", 400);
    expect(await openSessions(u.id)).toBe(3);

    const n = await svc.revokeAllSessions({ actorId: u.id, userId: u.id, reason: "Laptop stolen", meta: META });
    expect(n).toBe(3);
    expect(await openSessions(u.id)).toBe(0);
    for (const s of sessions) expect(await svc.resolveSession({ sub: u.id, sv: s.sessionVersion, sid: s.sessionId })).toBeNull();
    const ev = await events(u.id, "all_sessions_revoked");
    expect(ev).toHaveLength(1);
    expect(ev[0].reason).toBe("Laptop stolen");
    expect(ev[0].details).toMatchObject({ sessions_ended: 3 });
    const reasons = await q<{ end_reason: string }>("SELECT DISTINCT end_reason FROM public.crm_auth_sessions WHERE user_id = $1", [u.id]);
    expect(reasons).toEqual([{ end_reason: "revoked_all" }]);
  });

  // ------------------------------------------------------------ acceptance 5 + 6
  describe("MFA", () => {
    async function enrolled(role: "subscriber" | "admin1" = "subscriber") {
      const u = await makeUser(role);
      const s = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      const { secret } = await svc.startMfaEnrollment(u.id, u.email);
      const { recoveryCodes } = await svc.confirmMfaEnrollment({ userId: u.id, sessionId: s.sessionId, code: totp.totpAt(secret, new Date()), meta: META });
      return { ...u, secret, recoveryCodes, session: s };
    }

    it("enrolment stores the secret encrypted and returns 10 recovery codes once", async () => {
      const u = await enrolled();
      expect(u.recoveryCodes).toHaveLength(10);
      const row = await one<{ mfa_enabled: boolean; mfa_secret_enc: string }>("SELECT mfa_enabled, mfa_secret_enc FROM public.crm_user_auth_security WHERE user_id = $1", [u.id]);
      expect(row.mfa_enabled).toBe(true);
      expect(row.mfa_secret_enc).not.toContain(u.secret);
      const hashes = await q<{ code_hash: string }>("SELECT code_hash FROM public.crm_mfa_recovery_codes WHERE user_id = $1", [u.id]);
      expect(hashes).toHaveLength(10);
      for (const c of u.recoveryCodes) expect(hashes.map((h) => h.code_hash)).not.toContain(c);
      expect(await events(u.id, "mfa_enrolled")).toHaveLength(1);
      // the enrolling session stays valid
      expect(await svc.resolveSession({ sub: u.id, sv: u.session.sessionVersion, sid: u.session.sessionId })).not.toBeNull();
    });

    it("a wrong enrolment code is refused and MFA stays off", async () => {
      const u = await makeUser();
      const s = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      await svc.startMfaEnrollment(u.id, u.email);
      await expectAuthError(svc.confirmMfaEnrollment({ userId: u.id, sessionId: s.sessionId, code: "000000", meta: META }), "mfa_failed");
      expect((await svc.getMfaStatus(u.id, "subscriber")).enabled).toBe(false);
    });

    it("an MFA user without a code gets mfa_required and no session", async () => {
      const u = await enrolled();
      const before = await openSessions(u.id);
      await expectAuthError(svc.signInSecure({ email: u.email, password: PASSWORD }, META), "mfa_required", 401);
      expect(await openSessions(u.id)).toBe(before);
      expect((await attempts(u.id)).at(-1)).toEqual({ outcome: "mfa_required", session_id: null, ip_address: "203.0.113.7" });
    });

    it("the right TOTP code signs in with an MFA-verified session", async () => {
      const u = await enrolled();
      const r = await svc.signInSecure({ email: u.email, password: PASSWORD, code: totp.totpAt(u.secret, new Date()) }, META);
      const s = await one<{ mfa_verified_at: string | null }>("SELECT mfa_verified_at FROM public.crm_auth_sessions WHERE id = $1", [r.sessionId]);
      expect(s.mfa_verified_at).not.toBeNull();
    });

    it("a wrong TOTP code is mfa_failed", async () => {
      const u = await enrolled();
      await expectAuthError(svc.signInSecure({ email: u.email, password: PASSWORD, code: "000000" }, META), "mfa_failed");
      expect((await attempts(u.id)).at(-1)?.outcome).toBe("mfa_failed");
    });

    it("a recovery code works exactly once", async () => {
      const u = await enrolled();
      const code = u.recoveryCodes[3];
      const r = await svc.signInSecure({ email: u.email, password: PASSWORD, recoveryCode: code.toUpperCase() }, META);
      expect(r.sessionId).toBeTruthy();
      expect((await attempts(u.id)).at(-1)?.outcome).toBe("mfa_recovery_code_used");
      expect(await events(u.id, "mfa_recovery_code_used")).toHaveLength(1);
      await expectAuthError(svc.signInSecure({ email: u.email, password: PASSWORD, recoveryCode: code }, META), "mfa_failed");
      const left = await svc.getMfaStatus(u.id, "subscriber");
      expect(left.recoveryCodesLeft).toBe(9);
    });

    it("regenerating recovery codes invalidates the old ones", async () => {
      const u = await enrolled();
      const fresh = await svc.regenerateRecoveryCodes({ userId: u.id, code: totp.totpAt(u.secret, new Date()), meta: META });
      expect(fresh).toHaveLength(10);
      await expectAuthError(svc.signInSecure({ email: u.email, password: PASSWORD, recoveryCode: u.recoveryCodes[0] }, META), "mfa_failed");
      const ok = await svc.signInSecure({ email: u.email, password: PASSWORD, recoveryCode: fresh[0] }, META);
      expect(ok.sessionId).toBeTruthy();
      expect(await events(u.id, "mfa_recovery_codes_regenerated")).toHaveLength(1);
    });

    it("a subscriber can turn MFA off with password + code; an Admin cannot", async () => {
      const sub = await enrolled("subscriber");
      await svc.disableMfa({ userId: sub.id, role: "subscriber", password: PASSWORD, code: totp.totpAt(sub.secret, new Date()), meta: META });
      expect((await svc.getMfaStatus(sub.id, "subscriber")).enabled).toBe(false);
      expect(await events(sub.id, "mfa_disabled")).toHaveLength(1);

      const adm = await enrolled("admin1");
      await expectAuthError(
        svc.disableMfa({ userId: adm.id, role: "admin1", password: PASSWORD, code: totp.totpAt(adm.secret, new Date()), meta: META }),
        "forbidden",
        403,
      );
      expect((await svc.getMfaStatus(adm.id, "admin1")).enabled).toBe(true);
    });

    it("turning MFA on ends the user's other sessions that never passed MFA", async () => {
      const u = await makeUser();
      const other = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      const s = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      const { secret } = await svc.startMfaEnrollment(u.id, u.email);
      await svc.confirmMfaEnrollment({ userId: u.id, sessionId: s.sessionId, code: totp.totpAt(secret, new Date()), meta: META });
      expect(await svc.resolveSession({ sub: u.id, sv: other.sessionVersion, sid: other.sessionId })).toBeNull();
      expect(await svc.resolveSession({ sub: u.id, sv: s.sessionVersion, sid: s.sessionId })).not.toBeNull();
    });
  });

  describe("mandatory MFA for Super Admin and Admin", () => {
    it.each(["super_admin", "admin1", "admin2"] as const)("%s without MFA gets a session restricted to enrolment", async (role) => {
      const u = await makeUser(role);
      const r = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      expect(r.restrictions).toEqual(["mfa_enrollment"]);
      const resolved = await svc.resolveSession({ sub: u.id, sv: r.sessionVersion, sid: r.sessionId });
      expect(resolved?.restrictions).toEqual(["mfa_enrollment"]);

      const { secret } = await svc.startMfaEnrollment(u.id, u.email);
      await svc.confirmMfaEnrollment({ userId: u.id, sessionId: r.sessionId, code: totp.totpAt(secret, new Date()), meta: META });
      const after = await svc.resolveSession({ sub: u.id, sv: r.sessionVersion, sid: r.sessionId });
      expect(after?.restrictions).toEqual([]);
    });

    it("a subscriber without MFA is not restricted", async () => {
      const u = await makeUser("subscriber");
      expect((await svc.signInSecure({ email: u.email, password: PASSWORD }, META)).restrictions).toEqual([]);
    });
  });

  // ------------------------------------------------------------ acceptance 7
  describe("temporary passwords", () => {
    it("an Admin issues one for a subscriber; the user must change it, then is unrestricted", async () => {
      const admin = await makeUser("admin2");
      const target = await makeUser("subscriber");
      const before = await svc.signInSecure({ email: target.email, password: PASSWORD }, META);

      const { password, expiresAt } = await svc.issueTemporaryPassword({ actorId: admin.id, targetUserId: target.id, meta: META });
      expect(password.length).toBeGreaterThanOrEqual(16);
      const hours = (new Date(expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThanOrEqual(72);
      // existing sessions of the target end
      expect(await svc.resolveSession({ sub: target.id, sv: before.sessionVersion, sid: before.sessionId })).toBeNull();
      const ev = await events(target.id, "temp_password_issued");
      expect(ev).toHaveLength(1);
      expect(ev[0].actor_id).toBe(admin.id);
      expect(JSON.stringify(ev[0].details)).not.toContain(password);

      const s = await svc.signInSecure({ email: target.email, password }, META);
      expect(s.restrictions).toEqual(["password_change"]);
      await svc.changePasswordSecure({ userId: target.id, sessionId: s.sessionId, current: password, next: "a-brand-new-password", meta: META });
      const after = await svc.resolveSession({ sub: target.id, sv: s.sessionVersion, sid: s.sessionId });
      expect(after?.restrictions).toEqual([]);
      expect(await events(target.id, "password_changed")).toHaveLength(1);
    });

    it("an expired temporary password is refused", async () => {
      const admin = await makeUser("super_admin");
      const target = await makeUser("subscriber");
      const { password } = await svc.issueTemporaryPassword({ actorId: admin.id, targetUserId: target.id, meta: META });
      await db.query("UPDATE public.crm_user_auth_security SET temp_password_expires_at = now() - interval '1 minute' WHERE user_id = $1", [target.id]);
      await expectAuthError(svc.signInSecure({ email: target.email, password }, META), "temp_password_expired", 401);
      expect((await attempts(target.id)).at(-1)).toEqual({ outcome: "temp_password_expired", session_id: null, ip_address: "203.0.113.7" });
    });

    it.each([
      ["admin1", "admin2"],
      ["admin2", "super_admin"],
      ["subscriber", "subscriber"],
    ] as const)("%s may not issue one for %s", async (actorRole, targetRole) => {
      const actor = await makeUser(actorRole);
      const target = await makeUser(targetRole);
      await expectAuthError(
        svc.issueTemporaryPassword({ actorId: actor.id, targetUserId: target.id, meta: META }),
        "forbidden",
        403,
      );
    });

    it("nobody issues one for themselves", async () => {
      const admin = await makeUser("super_admin");
      await expectAuthError(
        svc.issueTemporaryPassword({ actorId: admin.id, targetUserId: admin.id, meta: META }),
        "forbidden",
        403,
      );
    });
  });

  describe("password change and reset", () => {
    it("changing the password ends the user's other sessions", async () => {
      const u = await makeUser();
      const other = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      const cur = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      await expectAuthError(
        svc.changePasswordSecure({ userId: u.id, sessionId: cur.sessionId, current: "wrong", next: "another-password", meta: META }),
        "wrong_password",
        403,
      );
      await svc.changePasswordSecure({ userId: u.id, sessionId: cur.sessionId, current: PASSWORD, next: "another-password", meta: META });
      expect(await svc.resolveSession({ sub: u.id, sv: other.sessionVersion, sid: other.sessionId })).toBeNull();
      expect(await svc.resolveSession({ sub: u.id, sv: cur.sessionVersion, sid: cur.sessionId })).not.toBeNull();
      expect((await one<{ end_reason: string }>("SELECT end_reason FROM public.crm_auth_sessions WHERE id = $1", [other.sessionId])).end_reason).toBe("password_changed");
    });

    it("a reset request is logged with the IP; completing it ends all sessions and clears a lock", async () => {
      const { sendMail } = await import("./mailer");
      const u = await makeUser();
      const old = await svc.signInSecure({ email: u.email, password: PASSWORD }, META);
      await db.query(
        "UPDATE public.crm_user_auth_security SET locked_until = now() + interval '10 minutes' WHERE user_id = $1",
        [u.id],
      );
      await svc.requestPasswordResetSecure(u.email, "http://localhost:3000", META);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const tok = await one<{ requested_ip: string }>("SELECT host(requested_ip) requested_ip FROM public.password_reset_tokens WHERE user_id = $1", [u.id]);
      expect(tok.requested_ip).toBe("203.0.113.7");
      expect(await events(u.id, "password_reset_requested")).toHaveLength(1);

      const link = String((sendMail as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2]);
      const token = /token=([A-Za-z0-9_-]+)/.exec(link)![1];
      const r = await svc.resetPasswordSecure({ token, password: "reset-new-password", meta: META });
      expect(r.userId).toBe(u.id);
      expect(await svc.resolveSession({ sub: u.id, sv: old.sessionVersion, sid: old.sessionId })).toBeNull();
      expect(await events(u.id, "password_reset_completed")).toHaveLength(1);
      const sec = await one<{ locked_until: string | null; failed_login_count: number }>(
        "SELECT locked_until, failed_login_count FROM public.crm_user_auth_security WHERE user_id = $1",
        [u.id],
      );
      expect(sec).toEqual({ locked_until: null, failed_login_count: 0 });
      // the token cannot be reused
      await expectAuthError(svc.resetPasswordSecure({ token, password: "again-password", meta: META }), "invalid_token");
    });

    it("a reset request for an unknown email reveals nothing and logs nothing", async () => {
      const { sendMail } = await import("./mailer");
      await svc.requestPasswordResetSecure("nobody-here@test.local", "http://localhost:3000", META);
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe("session validity", () => {
    it("a Super Admin session idle for over 30 minutes ends as timeout", async () => {
      const u = await makeUser("super_admin");
      const s = await svc.createSession(u.id, META, { mfaVerified: true });
      expect(await svc.resolveSession({ sub: u.id, sv: s.sessionVersion, sid: s.sessionId })).not.toBeNull();
      await db.query("UPDATE public.crm_auth_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1", [s.sessionId]);
      expect(await svc.resolveSession({ sub: u.id, sv: s.sessionVersion, sid: s.sessionId })).toBeNull();
      expect((await one<{ end_reason: string }>("SELECT end_reason FROM public.crm_auth_sessions WHERE id = $1", [s.sessionId])).end_reason).toBe("timeout");
    });

    it("a sid that does not exist, or belongs to another user, is rejected", async () => {
      const a = await makeUser();
      const b = await makeUser();
      const s = await svc.signInSecure({ email: a.email, password: PASSWORD }, META);
      expect(await svc.resolveSession({ sub: b.id, sv: 1, sid: s.sessionId })).toBeNull();
      expect(await svc.resolveSession({ sub: a.id, sv: 1, sid: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    });

    it("the local auto-login session (MFA-verified) is not forced to enrol", async () => {
      const u = await makeUser("super_admin");
      const s = await svc.createSession(u.id, { ip: null, userAgent: "auto-login" }, { mfaVerified: true });
      expect((await svc.resolveSession({ sub: u.id, sv: s.sessionVersion, sid: s.sessionId }))?.restrictions).toEqual([]);
    });
  });

  it("no secret ever reaches the audit trail", async () => {
    const rows = await q<{ t: string }>("SELECT details::text || coalesce(reason, '') AS t FROM public.crm_user_events");
    for (const r of rows) {
      expect(r.t).not.toMatch(/password_hash|\$2[aby]\$|mfa_secret|otpauth/i);
      expect(r.t).not.toContain(PASSWORD);
    }
  });
});

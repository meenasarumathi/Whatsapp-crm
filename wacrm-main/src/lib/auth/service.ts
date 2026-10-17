// ============================================================
// Account credentials: sign-up, sign-in, password change/reset. Talks to
// public.users through the owner connection (the application role has no
// access to that table).
// ============================================================

import { createHash, randomBytes } from "node:crypto";

import { getPool } from "@/lib/db/pool";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password";
import { sendMail } from "./mailer";

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

export interface AuthUserRow {
  id: string;
  email: string;
  session_version: number;
}

export async function signUp(emailIn: unknown, password: unknown, fullName: unknown): Promise<AuthUserRow> {
  const email = normEmail(emailIn);
  if (!EMAIL_RE.test(email)) throw new AuthError("Enter a valid email address");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const name = typeof fullName === "string" ? fullName.trim().slice(0, 200) : "";
  const hash = await hashPassword(password);
  try {
    const { rows } = await getPool().query<AuthUserRow>(
      `INSERT INTO public.users (email, password_hash, raw_user_meta_data, email_confirmed_at, last_sign_in_at)
       VALUES ($1, $2, $3::jsonb, now(), now()) RETURNING id, email, session_version`,
      [email, hash, JSON.stringify({ full_name: name })],
    );
    return rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AuthError("An account with this email already exists", 409);
    throw e;
  }
}

/** Admin-created user: no session is started. */
export async function createUserWithPassword(emailIn: unknown, password: unknown, fullName: unknown): Promise<AuthUserRow> {
  return signUp(emailIn, password, fullName);
}

export async function signIn(emailIn: unknown, password: unknown): Promise<AuthUserRow> {
  const email = normEmail(emailIn);
  const { rows } = await getPool().query<AuthUserRow & { password_hash: string | null }>(
    "SELECT id, email, session_version, password_hash FROM public.users WHERE lower(email) = $1",
    [email],
  );
  const u = rows[0];
  // Same message and similar work whether the email exists or not.
  const ok = await verifyPassword(typeof password === "string" ? password : "", u?.password_hash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
  if (!u || !ok) throw new AuthError("Invalid login credentials", 401);
  await getPool().query("UPDATE public.users SET last_sign_in_at = now() WHERE id = $1", [u.id]);
  return { id: u.id, email: u.email, session_version: u.session_version };
}

export async function changePassword(userId: string, current: unknown, next: unknown): Promise<AuthUserRow> {
  if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const { rows } = await getPool().query<{ password_hash: string | null }>("SELECT password_hash FROM public.users WHERE id = $1", [userId]);
  if (!(await verifyPassword(typeof current === "string" ? current : "", rows[0]?.password_hash))) {
    throw new AuthError("Current password is incorrect", 403);
  }
  const hash = await hashPassword(next);
  const r = await getPool().query<AuthUserRow>(
    "UPDATE public.users SET password_hash = $2 WHERE id = $1 RETURNING id, email, session_version",
    [userId, hash],
  );
  return r.rows[0];
}

export async function changeEmail(userId: string, emailIn: unknown): Promise<void> {
  const email = normEmail(emailIn);
  if (!EMAIL_RE.test(email)) throw new AuthError("Enter a valid email address");
  try {
    await getPool().query("UPDATE public.users SET email = $2 WHERE id = $1", [userId, email]);
    await getPool().query("UPDATE public.profiles SET email = $2 WHERE user_id = $1", [userId, email]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AuthError("That email is already in use", 409);
    throw e;
  }
}

/** Bumps session_version: every existing cookie stops working ("sign out everywhere"). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const r = await getPool().query<{ session_version: number }>(
    "UPDATE public.users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version",
    [userId],
  );
  return r.rows[0]?.session_version ?? 1;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function requestPasswordReset(emailIn: unknown, origin: string): Promise<void> {
  const email = normEmail(emailIn);
  const { rows } = await getPool().query<{ id: string }>("SELECT id FROM public.users WHERE lower(email) = $1", [email]);
  if (!rows[0]) return; // never reveal whether an address is registered
  const token = randomBytes(32).toString("base64url");
  await getPool().query(
    "INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [rows[0].id, sha256(token)],
  );
  const link = `${origin}/reset-password?token=${token}`;
  await sendMail(email, "Reset your WACRM password", `Use this link within one hour to choose a new password:\n\n${link}\n\nIf you did not ask for this, ignore this message.`);
}

export async function resetPassword(token: unknown, password: unknown): Promise<AuthUserRow> {
  if (typeof token !== "string" || !token) throw new AuthError("Reset link is invalid or has expired");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const t = await client.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM public.password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE",
      [sha256(token)],
    );
    if (!t.rows[0]) throw new AuthError("Reset link is invalid or has expired");
    const hash = await hashPassword(password);
    const u = await client.query<AuthUserRow>(
      "UPDATE public.users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING id, email, session_version",
      [t.rows[0].user_id, hash],
    );
    await client.query("UPDATE public.password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [t.rows[0].user_id]);
    await client.query("COMMIT");
    return u.rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

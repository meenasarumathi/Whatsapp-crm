// ============================================================
// Account credentials: sign-up and email change. Talks to public.users
// through the owner connection (the application role has no access to
// that table).
//
// Sign-in, sessions, MFA, password change and reset live in
// ./security-service (lockout, per-session rows, audit events).
// ============================================================

import { getPool } from "@/lib/db/pool";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password";

export class AuthError extends Error {
  /** `code` is a stable machine-readable reason (e.g. "mfa_required"); `message` is for people. */
  constructor(message: string, readonly status = 400, readonly code?: string) {
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

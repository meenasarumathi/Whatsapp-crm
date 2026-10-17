// Password hashing (bcrypt). Hashes imported from the previous auth service are bcrypt too,
// so existing users keep their passwords.
import bcrypt from "bcryptjs";

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

export const MIN_PASSWORD_LENGTH = 6;

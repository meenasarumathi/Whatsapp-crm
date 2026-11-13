"use client";
// Browser auth client — thin wrapper over /api/auth/*. Mirrors the small slice of the
// previous auth SDK the UI used, so call sites stay readable.

export interface BrowserUser {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  user_metadata: Record<string, unknown>;
}
type Err = { message: string; status?: number; code?: string } | null;

/** Where a signed-in but restricted session (temporary password, MFA set-up) is sent. */
export const ACCOUNT_SECURITY_PATH = "/account-security";

async function call(path: string, body?: unknown, method = "POST"): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      credentials: "same-origin",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: { message: e instanceof Error ? e.message : "Network error" } } };
  }
}
const errOf = (r: { ok: boolean; status: number; json: Record<string, unknown> }): Err => {
  if (r.ok) return null;
  const e = r.json.error as { message?: string; code?: string } | undefined;
  return { message: e?.message ?? "Request failed", status: r.status, ...(e?.code ? { code: e.code } : {}) };
};

export interface BrowserAuth {
  getUser(): Promise<{ data: { user: BrowserUser | null }; error: Err }>;
  getSession(): Promise<{ data: { session: { user: BrowserUser } | null }; error: Err }>;
  /** `code` / `recoveryCode` answer an "mfa_required" error. `restrictions` non-empty → go to ACCOUNT_SECURITY_PATH. */
  signInWithPassword(c: { email: string; password: string; code?: string; recoveryCode?: string }): Promise<{ error: Err; restrictions: string[] }>;
  signUp(c: { email: string; password: string; fullName?: string }): Promise<{ error: Err }>;
  signOut(opts?: { scope?: "global" | "local" }): Promise<{ error: Err }>;
  updatePassword(c: { current: string; next: string }): Promise<{ error: Err }>;
  updateEmail(email: string): Promise<{ error: Err }>;
  resetPasswordForEmail(email: string): Promise<{ error: Err }>;
  resetPassword(c: { token: string; password: string }): Promise<{ error: Err }>;
}

export function createAuthClient(): BrowserAuth {
  const me = async (): Promise<BrowserUser | null> => {
    const r = await call("me", undefined, "GET");
    const restrictions = Array.isArray(r.json.restrictions) ? r.json.restrictions : [];
    // A valid but restricted session must finish set-up before using the app.
    // The middleware (cookie signature only) would bounce /login back to the
    // dashboard, so redirect here, before any "no user → /login" logic runs,
    // and never resolve so that logic cannot race this navigation.
    if (restrictions.length && typeof window !== "undefined" && window.location.pathname !== ACCOUNT_SECURITY_PATH) {
      window.location.replace(ACCOUNT_SECURITY_PATH);
      return new Promise<never>(() => {});
    }
    return (r.json.user as BrowserUser | null) ?? null;
  };
  return {
    async getUser() {
      return { data: { user: await me() }, error: null };
    },
    async getSession() {
      const user = await me();
      return { data: { session: user ? { user } : null }, error: null };
    },
    async signInWithPassword(c) {
      const r = await call("login", c);
      const restrictions = Array.isArray(r.json.restrictions) ? (r.json.restrictions as string[]) : [];
      return { error: errOf(r), restrictions };
    },
    async signUp(c) {
      return { error: errOf(await call("signup", c)) };
    },
    async signOut(opts) {
      return { error: errOf(await call("logout", { scope: opts?.scope })) };
    },
    async updatePassword(c) {
      return { error: errOf(await call("change-password", c)) };
    },
    async updateEmail(email) {
      return { error: errOf(await call("change-email", { email })) };
    },
    async resetPasswordForEmail(email) {
      return { error: errOf(await call("forgot-password", { email })) };
    },
    async resetPassword(c) {
      return { error: errOf(await call("reset-password", c)) };
    },
  };
}

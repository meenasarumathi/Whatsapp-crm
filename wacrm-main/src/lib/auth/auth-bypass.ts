// ============================================================
// Local "no login" switch. Set AUTH_BYPASS_USER_ID in .env.local and
// every visit on this computer is signed in as that user. Runs in the
// Edge runtime too (middleware), so it has no server-only imports.
//
// It never applies to a production server or to a request that came in
// on a public hostname (a tunnel such as ngrok, a real domain).
// ============================================================

export const AUTO_LOGIN_PATH = "/api/auth/auto-login";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(hostHeader: string | null): string {
  if (!hostHeader) return "";
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}

/** The user to sign in automatically for this request, or null when the switch doesn't apply. */
export function authBypassUserId(hostHeader: string | null): string | null {
  const userId = process.env.AUTH_BYPASS_USER_ID?.trim();
  if (!userId || process.env.NODE_ENV === "production") return null;
  return LOOPBACK_HOSTS.has(hostnameOf(hostHeader)) ? userId : null;
}

/** Only same-site paths, so the redirect can't be pointed at another website. */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/dashboard";
  return next;
}

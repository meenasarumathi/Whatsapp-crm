// ============================================================
// Instagram API (Instagram Login) client — the calls the CRM needs.
// Docs: developers.facebook.com/docs/instagram-platform
//   send DM / private reply   POST /{ig-user-id}/messages
//   public comment reply      POST /{comment-id}/replies
//   who am I                  GET  /me?fields=user_id,username
//   receive webhooks          POST /{ig-user-id}/subscribed_apps
//   keep the token alive      GET  /refresh_access_token
// All calls go to graph.instagram.com with the account's access token.
// ============================================================

const HOST = 'https://graph.instagram.com'
const API = `${HOST}/v27.0`

export class InstagramApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T
  if (!res.ok) throw new InstagramApiError(body.error?.message ?? `Instagram API ${res.status}`, res.status)
  return body
}

export type DmRecipient = { id: string } | { comment_id: string }

/** Send a DM, or a private reply to a comment ({ comment_id }). Returns the message id. */
export async function sendInstagramMessage(args: {
  token: string
  igUserId: string
  recipient: DmRecipient
  text: string
}): Promise<string> {
  const body = await call<{ message_id?: string }>(`/${encodeURIComponent(args.igUserId)}/messages`, args.token, {
    method: 'POST',
    body: JSON.stringify({ recipient: args.recipient, message: { text: args.text } }),
  })
  return body.message_id ?? ''
}

/** Public reply under a comment. Returns the new comment id. */
export async function replyToComment(args: { token: string; commentId: string; text: string }): Promise<string> {
  const body = await call<{ id?: string }>(`/${encodeURIComponent(args.commentId)}/replies`, args.token, {
    method: 'POST',
    body: JSON.stringify({ message: args.text }),
  })
  return body.id ?? ''
}

/**
 * Validates a token and returns the professional account behind it.
 * Meta's docs do not say whether `user_id` or `id` is the entry.id used in
 * webhooks, so both are returned and the webhook matches either.
 */
export async function fetchInstagramMe(token: string): Promise<{ userId: string; altId: string | null; username: string }> {
  const body = await call<{ user_id?: string; id?: string; username?: string }>(
    `/me?${new URLSearchParams({ fields: 'id,user_id,username', access_token: token })}`,
    token,
  )
  const userId = String(body.user_id ?? body.id ?? '')
  const altId = body.id && String(body.id) !== userId ? String(body.id) : null
  return { userId, altId, username: body.username ?? '' }
}

/** Turns on webhook delivery for this account. Required on top of the app dashboard setup. */
export async function subscribeInstagramWebhooks(token: string, igUserId: string, fields: string[]): Promise<void> {
  const query = new URLSearchParams({ subscribed_fields: fields.join(','), access_token: token })
  await call(`/${encodeURIComponent(igUserId)}/subscribed_apps?${query}`, token, { method: 'POST' })
}

/** New 60-day token. Meta requires the current one to be at least 24 hours old and unexpired. */
export async function refreshInstagramToken(token: string): Promise<string> {
  const query = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })
  const res = await fetch(`${HOST}/refresh_access_token?${query}`, { signal: AbortSignal.timeout(15_000) })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } }
  if (!res.ok || !body.access_token) {
    throw new InstagramApiError(body.error?.message ?? `Instagram API ${res.status}`, res.status)
  }
  return body.access_token
}

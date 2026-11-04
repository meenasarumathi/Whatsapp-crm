// ============================================================
// Instagram API (Instagram Login) client — the four calls the CRM needs.
// Docs: developers.facebook.com/docs/instagram-platform
//   send DM / private reply   POST /{ig-user-id}/messages
//   public comment reply      POST /{comment-id}/replies
//   who am I                  GET  /me?fields=user_id,username
// All calls go to graph.instagram.com with the account's access token.
// ============================================================

const API = 'https://graph.instagram.com/v21.0'

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

/** Validates a token and returns the professional account behind it. */
export async function fetchInstagramMe(token: string): Promise<{ userId: string; username: string }> {
  const body = await call<{ user_id?: string; id?: string; username?: string }>('/me?fields=user_id,username', token)
  return { userId: String(body.user_id ?? body.id ?? ''), username: body.username ?? '' }
}

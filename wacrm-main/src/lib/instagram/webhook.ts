// ============================================================
// Instagram webhook: signature check + normalising Meta's payload into
// one flat event shape. Pure (no I/O) so it is unit-tested directly.
//
// Payload shapes (object = "instagram"):
//   DMs / story mentions / story replies → entry[].messaging[]
//   comments                             → entry[].changes[] with field "comments"
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'

export type InstagramEventKind = 'dm' | 'story_mention' | 'story_reply' | 'comment'

export interface InstagramEvent {
  kind: InstagramEventKind
  /** The business account the event belongs to (entry.id). */
  igUserId: string
  /** The customer (IGSID). */
  senderId: string
  username: string | null
  text: string
  /** DM message id, or the comment id for comments; used to dedupe retries. */
  mid: string
  commentId: string | null
  mediaId: string | null
  timestamp: number
}

/** True when `header` (X-Hub-Signature-256) matches the raw body for any of the secrets. */
export function verifyInstagramSignature(rawBody: string, header: string | null, secrets: string[]): boolean {
  if (!header?.startsWith('sha256=')) return false
  const supplied = Buffer.from(header.slice(7), 'hex')
  return secrets.some((secret) => {
    if (!secret) return false
    const expected = createHmac('sha256', secret).update(rawBody).digest()
    return expected.length === supplied.length && timingSafeEqual(expected, supplied)
  })
}

interface RawMessaging {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    is_deleted?: boolean
    attachments?: { type?: string; payload?: { url?: string } }[]
    reply_to?: { story?: { id?: string; url?: string } }
  }
}

interface RawChange {
  field?: string
  value?: { id?: string; text?: string; from?: { id?: string; username?: string }; media?: { id?: string } }
}

/** Customer-originated events only: echoes of our own sends and deletions are dropped. */
export function parseInstagramWebhook(payload: unknown): InstagramEvent[] {
  const p = payload as { object?: string; entry?: { id?: string; time?: number; messaging?: RawMessaging[]; changes?: RawChange[] }[] }
  if (p?.object !== 'instagram' || !Array.isArray(p.entry)) return []
  const out: InstagramEvent[] = []
  for (const entry of p.entry) {
    const igUserId = String(entry.id ?? '')
    if (!igUserId) continue
    for (const m of entry.messaging ?? []) {
      const msg = m.message
      const senderId = m.sender?.id
      if (!msg?.mid || !senderId || msg.is_echo || msg.is_deleted || senderId === igUserId) continue
      const mention = msg.attachments?.some((a) => a.type === 'story_mention')
      out.push({
        kind: mention ? 'story_mention' : msg.reply_to?.story ? 'story_reply' : 'dm',
        igUserId,
        senderId,
        username: null,
        text: msg.text ?? '',
        mid: msg.mid,
        commentId: null,
        mediaId: msg.reply_to?.story?.id ?? null,
        timestamp: m.timestamp ?? entry.time ?? Date.now(),
      })
    }
    for (const c of entry.changes ?? []) {
      const v = c.value
      if (c.field !== 'comments' || !v?.id || !v.from?.id || v.from.id === igUserId) continue
      out.push({
        kind: 'comment',
        igUserId,
        senderId: v.from.id,
        username: v.from.username ?? null,
        text: v.text ?? '',
        mid: v.id,
        commentId: v.id,
        mediaId: v.media?.id ?? null,
        timestamp: (entry.time ?? Math.floor(Date.now() / 1000)) * 1000,
      })
    }
  }
  return out
}

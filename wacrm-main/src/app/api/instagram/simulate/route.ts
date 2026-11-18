import { NextResponse } from 'next/server'
import { createHash, randomUUID } from 'node:crypto'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadInstagramConnection, processInstagramEvent } from '@/lib/instagram/engine'
import type { InstagramEventKind } from '@/lib/instagram/webhook'

const KINDS: InstagramEventKind[] = ['dm', 'story_mention', 'story_reply', 'comment']

/**
 * Test the Instagram automations without Meta: builds the event a real
 * webhook would deliver and runs it through the engine with sending
 * forced OFF (replies are stored as 'simulated', nothing is charged),
 * even when an account is connected.
 * Body: { kind, text, username, media_id? }
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => ({}))) as { kind?: unknown; text?: unknown; username?: unknown; media_id?: unknown }
    const kind = KINDS.includes(body.kind as InstagramEventKind) ? (body.kind as InstagramEventKind) : 'dm'
    const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim().replace(/^@/, '').slice(0, 30) : 'test_customer'
    const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : ''
    const senderId = `sim_${createHash('sha256').update(`${ctx.accountId}:${username}`).digest('hex').slice(0, 16)}`
    const mid = `sim_${randomUUID()}`
    const conn = { ...(await loadInstagramConnection(ctx.accountId)), token: null }
    const result = await processInstagramEvent(
      ctx.accountId,
      {
        kind,
        igUserId: conn.igUserId ?? 'simulated',
        senderId,
        username,
        text,
        mid,
        commentId: kind === 'comment' ? mid : null,
        mediaId: typeof body.media_id === 'string' && body.media_id ? body.media_id : null,
        timestamp: Date.now(),
      },
      { connection: conn },
    )
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}

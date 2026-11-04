import { NextResponse, after } from 'next/server'

import { serviceDb } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { processInstagramEvent } from '@/lib/instagram/engine'
import { parseInstagramWebhook, verifyInstagramSignature, type InstagramEvent } from '@/lib/instagram/webhook'

/**
 * Meta → CRM webhook for Instagram (DMs, story mentions, comments).
 * Callback URL: https://<your-domain>/api/instagram/webhook
 * Verify token: shown in Instagram → Connect (per account).
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token') ?? ''
  const challenge = url.searchParams.get('hub.challenge') ?? ''
  if (mode !== 'subscribe' || !token) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { data } = await serviceDb().from('instagram_accounts').select('account_id').eq('verify_token', token).maybeSingle()
  if (!data) return NextResponse.json({ error: 'Unknown verify token' }, { status: 403 })
  return new NextResponse(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
}

function envSecrets(): string[] {
  return [process.env.INSTAGRAM_APP_SECRET ?? '', ...(process.env.META_APP_SECRET ?? '').split(',')]
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const events = parseInstagramWebhook(payload)
  const byIgUser = new Map<string, InstagramEvent[]>()
  for (const e of events) byIgUser.set(e.igUserId, [...(byIgUser.get(e.igUserId) ?? []), e])

  // Resolve each business account and the secret its app signs with.
  const db = serviceDb()
  const targets: { accountId: string; events: InstagramEvent[]; secret: string | null }[] = []
  for (const [igUserId, list] of byIgUser) {
    const { data } = await db.from('instagram_accounts').select('account_id, app_secret_enc').eq('ig_user_id', igUserId).maybeSingle()
    const row = data as { account_id: string; app_secret_enc: string | null } | null
    if (!row) continue
    let secret: string | null = null
    if (row.app_secret_enc) {
      try {
        secret = decrypt(row.app_secret_enc)
      } catch {
        secret = null
      }
    }
    targets.push({ accountId: row.account_id, events: list, secret })
  }

  const signature = request.headers.get('x-hub-signature-256')
  const secrets = [...envSecrets(), ...targets.map((t) => t.secret ?? '').filter(Boolean)]
  if (!verifyInstagramSignature(rawBody, signature, secrets)) {
    console.warn('[instagram webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Ack fast; process after the response (same pattern as the WhatsApp webhook).
  after(async () => {
    for (const t of targets) {
      for (const e of t.events) await processInstagramEvent(t.accountId, e)
    }
  })
  return NextResponse.json({ ok: true })
}

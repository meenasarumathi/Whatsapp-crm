import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { serviceDb } from '@/lib/automations/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import { hasMinRole, type AccountRole } from '@/lib/auth/roles'
import {
  checkInstagramToken,
  connectInstagramToken,
  verifyInstagramConnection,
  type InstagramAccountRow,
  type TokenHealth,
} from '@/lib/instagram/connection'
import { defaultInstagramAutomations } from '@/lib/instagram/defaults'

async function ensureRow(accountId: string, userId: string) {
  const db = serviceDb()
  // Atomic create: concurrent first visits (two tabs, React dev double
  // effects) race here, and only the request whose insert actually
  // created the row may seed the defaults — otherwise they double up.
  const { data: created } = await db
    .from('instagram_accounts')
    .upsert({ account_id: accountId }, { onConflict: 'account_id', ignoreDuplicates: true })
    .select('account_id')
  if ((created ?? []).length > 0) {
    // First visit: seed the five basic automations as drafts.
    await db.from('instagram_automations').insert(defaultInstagramAutomations(accountId, userId))
  }
  const { data } = await db.from('instagram_accounts').select('*').eq('account_id', accountId).single()
  return data as Record<string, unknown>
}

function publicView(row: Record<string, unknown>, role: AccountRole, token?: TokenHealth) {
  return {
    connected: Boolean(row.access_token_enc && row.ig_user_id),
    ig_user_id: row.ig_user_id ?? null,
    username: row.username ?? null,
    has_app_secret: Boolean(row.app_secret_enc),
    // Anyone holding this can complete Meta's webhook handshake: admins only.
    verify_token: hasMinRole(role, 'admin') ? row.verify_token : null,
    ai_auto_reply: Boolean(row.ai_auto_reply),
    connected_at: row.connected_at ?? null,
    last_event_at: row.last_event_at ?? null,
    webhook_subscribed_at: row.webhook_subscribed_at ?? null,
    webhook_error: row.webhook_error ?? null,
    ...(token ? { token_health: token } : {}),
  }
}

/** `?check=1` also pings Instagram to test the token (slower, like the WhatsApp health check). */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const row = await ensureRow(ctx.accountId, ctx.userId)
    const check = new URL(request.url).searchParams.get('check') === '1'
    const token = check ? await checkInstagramToken(row as unknown as InstagramAccountRow) : undefined
    return NextResponse.json(publicView(row, ctx.role, token))
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Body: { access_token?, app_secret?, ai_auto_reply?, disconnect?, verify? } — admins only. */
export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const current = await ensureRow(ctx.accountId, ctx.userId)
    const body = (await request.json().catch(() => ({}))) as {
      access_token?: unknown
      app_secret?: unknown
      ai_auto_reply?: unknown
      disconnect?: unknown
      verify?: unknown
    }
    const patch: Record<string, unknown> = {}
    if (body.disconnect === true) {
      Object.assign(patch, {
        access_token_enc: null,
        ig_user_id: null,
        ig_alt_id: null,
        username: null,
        connected_at: null,
        webhook_subscribed_at: null,
        webhook_error: null,
        token_refreshed_at: null,
      })
    }
    if (typeof body.access_token === 'string' && body.access_token.trim()) {
      try {
        Object.assign(patch, await connectInstagramToken(body.access_token.trim()))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Token check failed'
        return NextResponse.json({ error: `Instagram rejected the token: ${message}` }, { status: 400 })
      }
    } else if (body.verify === true) {
      Object.assign(patch, await verifyInstagramConnection(current as unknown as InstagramAccountRow))
    }
    if (typeof body.app_secret === 'string') {
      patch.app_secret_enc = body.app_secret.trim() ? encrypt(body.app_secret.trim()) : null
    }
    if (typeof body.ai_auto_reply === 'boolean') patch.ai_auto_reply = body.ai_auto_reply
    const { data, error } = await serviceDb()
      .from('instagram_accounts')
      .update(patch)
      .eq('account_id', ctx.accountId)
      .select('*')
      .single()
    if (error) {
      const taken = (error as { code?: string }).code === '23505'
      return NextResponse.json(
        { error: taken ? 'This Instagram account is already connected to another CRM account.' : error.message },
        { status: taken ? 409 : 500 },
      )
    }
    const row = data as Record<string, unknown>
    return NextResponse.json(publicView(row, ctx.role, await checkInstagramToken(row as unknown as InstagramAccountRow)))
  } catch (error) {
    return toErrorResponse(error)
  }
}

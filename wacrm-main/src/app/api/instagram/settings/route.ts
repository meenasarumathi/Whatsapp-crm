import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { serviceDb } from '@/lib/automations/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import { InstagramApiError, fetchInstagramMe } from '@/lib/instagram/graph'
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

function publicView(row: Record<string, unknown>) {
  return {
    connected: Boolean(row.access_token_enc && row.ig_user_id),
    ig_user_id: row.ig_user_id ?? null,
    username: row.username ?? null,
    has_app_secret: Boolean(row.app_secret_enc),
    verify_token: row.verify_token,
    ai_auto_reply: Boolean(row.ai_auto_reply),
    connected_at: row.connected_at ?? null,
    last_event_at: row.last_event_at ?? null,
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    return NextResponse.json(publicView(await ensureRow(ctx.accountId, ctx.userId)))
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Body: { access_token?, app_secret?, ai_auto_reply?, disconnect? } — admins only. */
export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await ensureRow(ctx.accountId, ctx.userId)
    const body = (await request.json().catch(() => ({}))) as {
      access_token?: unknown
      app_secret?: unknown
      ai_auto_reply?: unknown
      disconnect?: unknown
    }
    const patch: Record<string, unknown> = {}
    if (body.disconnect === true) {
      Object.assign(patch, { access_token_enc: null, ig_user_id: null, username: null, connected_at: null })
    }
    if (typeof body.access_token === 'string' && body.access_token.trim()) {
      const token = body.access_token.trim()
      try {
        const me = await fetchInstagramMe(token)
        if (!me.userId) throw new InstagramApiError('Token did not return an Instagram account', 400)
        Object.assign(patch, {
          access_token_enc: encrypt(token),
          ig_user_id: me.userId,
          username: me.username,
          connected_at: new Date().toISOString(),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Token check failed'
        return NextResponse.json({ error: `Instagram rejected the token: ${message}` }, { status: 400 })
      }
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
    return NextResponse.json(publicView(data as Record<string, unknown>))
  } catch (error) {
    return toErrorResponse(error)
  }
}

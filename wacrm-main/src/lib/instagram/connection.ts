// ============================================================
// Instagram connection lifecycle, the counterpart of the WhatsApp config
// route: check the token, subscribe the account to webhooks, report
// health, and refresh the token before its 60 days run out.
// ============================================================

import { serviceDb } from '@/lib/automations/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { InstagramApiError, fetchInstagramMe, refreshInstagramToken, subscribeInstagramWebhooks } from './graph'

export const WEBHOOK_FIELDS = ['messages', 'comments']

/** Refresh well before the 60-day expiry, so a few failed days are harmless. */
const REFRESH_AFTER_DAYS = 30

export type TokenHealth = 'none' | 'ok' | 'invalid' | 'unreachable'

export interface InstagramAccountRow {
  account_id: string
  ig_user_id: string | null
  ig_alt_id: string | null
  username: string | null
  access_token_enc: string | null
  app_secret_enc: string | null
  webhook_subscribed_at: string | null
  webhook_error: string | null
  token_refreshed_at: string | null
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500)

/** Validates the token and subscribes the account. Returns the row patch; a failed subscribe still connects. */
export async function connectInstagramToken(token: string): Promise<Record<string, unknown>> {
  const me = await fetchInstagramMe(token)
  if (!me.userId) throw new InstagramApiError('Token did not return an Instagram account', 400)
  const now = new Date().toISOString()
  return {
    access_token_enc: encrypt(token),
    ig_user_id: me.userId,
    ig_alt_id: me.altId,
    username: me.username,
    connected_at: now,
    token_refreshed_at: now,
    ...(await subscribePatch(token, me.userId)),
  }
}

async function subscribePatch(token: string, igUserId: string): Promise<Record<string, unknown>> {
  try {
    await subscribeInstagramWebhooks(token, igUserId, WEBHOOK_FIELDS)
    return { webhook_subscribed_at: new Date().toISOString(), webhook_error: null }
  } catch (err) {
    return { webhook_subscribed_at: null, webhook_error: message(err) }
  }
}

/** Re-runs the subscribe with the saved token (the "Verify with Instagram" button). */
export async function verifyInstagramConnection(row: InstagramAccountRow): Promise<Record<string, unknown>> {
  if (!row.access_token_enc || !row.ig_user_id) return {}
  let token: string
  try {
    token = decrypt(row.access_token_enc)
  } catch (err) {
    return { webhook_subscribed_at: null, webhook_error: `Saved token could not be read: ${message(err)}` }
  }
  return subscribePatch(token, row.ig_user_id)
}

/** A 4xx from Meta means the token is bad; anything else says nothing about the token. */
export async function checkInstagramToken(row: Pick<InstagramAccountRow, 'access_token_enc'>): Promise<TokenHealth> {
  if (!row.access_token_enc) return 'none'
  try {
    await fetchInstagramMe(decrypt(row.access_token_enc))
    return 'ok'
  } catch (err) {
    if (err instanceof InstagramApiError && err.status >= 400 && err.status < 500) return 'invalid'
    if (err instanceof InstagramApiError) return 'unreachable'
    // decrypt failed (ENCRYPTION_KEY changed) or the network dropped.
    return err instanceof TypeError || (err as { name?: string })?.name === 'TimeoutError' ? 'unreachable' : 'invalid'
  }
}

/** The account a webhook's entry.id belongs to, matching either id from /me. */
export async function findInstagramAccount(igId: string): Promise<{ account_id: string; app_secret_enc: string | null } | null> {
  const db = serviceDb()
  for (const column of ['ig_user_id', 'ig_alt_id']) {
    const { data } = await db.from('instagram_accounts').select('account_id, app_secret_enc').eq(column, igId).maybeSingle()
    if (data) return data as { account_id: string; app_secret_enc: string | null }
  }
  return null
}

/** Refreshes tokens older than REFRESH_AFTER_DAYS. Called by the scheduler; one failure doesn't stop the rest. */
export async function refreshDueInstagramTokens(now: Date = new Date()): Promise<{ refreshed: number; failed: number }> {
  const db = serviceDb()
  const cutoff = new Date(now.getTime() - REFRESH_AFTER_DAYS * 86_400_000).toISOString()
  const { data } = await db.from('instagram_accounts').select('account_id, access_token_enc, token_refreshed_at').lte('token_refreshed_at', cutoff)
  let refreshed = 0
  let failed = 0
  for (const row of (data ?? []) as Pick<InstagramAccountRow, 'account_id' | 'access_token_enc'>[]) {
    if (!row.access_token_enc) continue
    try {
      const token = await refreshInstagramToken(decrypt(row.access_token_enc))
      await db
        .from('instagram_accounts')
        .update({ access_token_enc: encrypt(token), token_refreshed_at: now.toISOString() })
        .eq('account_id', row.account_id)
      refreshed++
    } catch (err) {
      failed++
      console.error('[instagram] token refresh failed:', row.account_id, message(err))
    }
  }
  return { refreshed, failed }
}

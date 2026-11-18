import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDb, type MemoryDb } from '@/lib/automations/memory-db.test-helper'

const h = vi.hoisted(() => ({ db: null as unknown as MemoryDb }))
vi.mock('@/lib/automations/admin-client', () => ({ serviceDb: () => h.db }))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (t: string) => `enc:${t}`,
  decrypt: (t: string) => t.replace(/^enc:/, ''),
}))

import { checkInstagramToken, connectInstagramToken, findInstagramAccount, refreshDueInstagramTokens, verifyInstagramConnection, type InstagramAccountRow } from './connection'

type Reply = { status: number; body: unknown }
const calls: { url: string; method: string }[] = []
let replies: (url: string) => Reply

beforeEach(() => {
  calls.length = 0
  h.db = createMemoryDb({ instagram_accounts: [] })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    const r = replies(String(url))
    return new Response(JSON.stringify(r.body), { status: r.status })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const ok = (url: string): Reply =>
  url.includes('/me?') ? { status: 200, body: { id: 'app1', user_id: '1784', username: 'zenvy' } } : { status: 200, body: { success: true } }
const row = (over: Partial<InstagramAccountRow> = {}): InstagramAccountRow => ({
  account_id: 'a', ig_user_id: '1784', ig_alt_id: 'app1', username: 'zenvy', access_token_enc: 'enc:tok', app_secret_enc: null,
  webhook_subscribed_at: null, webhook_error: null, token_refreshed_at: null, ...over,
})

describe('connecting', () => {
  it('saves both ids, encrypts the token and subscribes the account to messages and comments', async () => {
    replies = ok
    const patch = await connectInstagramToken('tok')
    expect(patch).toEqual(expect.objectContaining({ access_token_enc: 'enc:tok', ig_user_id: '1784', ig_alt_id: 'app1', username: 'zenvy', webhook_error: null }))
    expect(patch.webhook_subscribed_at).toBeTruthy()
    const sub = calls.find((c) => c.url.includes('subscribed_apps'))!
    expect(sub.method).toBe('POST')
    expect(sub.url).toContain('/1784/subscribed_apps')
    expect(new URL(sub.url).searchParams.get('subscribed_fields')).toBe('messages,comments')
  })

  it('a rejected token throws and saves nothing', async () => {
    replies = () => ({ status: 400, body: { error: { message: 'Invalid OAuth access token' } } })
    await expect(connectInstagramToken('bad')).rejects.toThrow('Invalid OAuth')
    expect(calls.some((c) => c.url.includes('subscribed_apps'))).toBe(false)
  })

  it('a failed subscribe still connects but records why', async () => {
    replies = (u) => (u.includes('subscribed_apps') ? { status: 403, body: { error: { message: 'Missing permission' } } } : ok(u))
    const patch = await connectInstagramToken('tok')
    expect(patch).toEqual(expect.objectContaining({ ig_user_id: '1784', webhook_subscribed_at: null, webhook_error: 'Missing permission' }))
  })

  it('verify re-subscribes with the saved token', async () => {
    replies = ok
    expect((await verifyInstagramConnection(row())).webhook_subscribed_at).toBeTruthy()
    expect(await verifyInstagramConnection(row({ access_token_enc: null }))).toEqual({})
  })
})

describe('token health', () => {
  it('reports ok, invalid, and unreachable separately', async () => {
    expect(await checkInstagramToken({ access_token_enc: null })).toBe('none')
    replies = ok
    expect(await checkInstagramToken(row())).toBe('ok')
    replies = () => ({ status: 401, body: { error: { message: 'expired' } } })
    expect(await checkInstagramToken(row())).toBe('invalid')
    replies = () => ({ status: 503, body: {} })
    expect(await checkInstagramToken(row())).toBe('unreachable')
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await checkInstagramToken(row())).toBe('unreachable')
  })
})

describe('webhook routing', () => {
  it('finds the account by either id from /me', async () => {
    h.db.tables.instagram_accounts.push({ account_id: 'a', ig_user_id: '1784', ig_alt_id: 'app1', app_secret_enc: null })
    expect((await findInstagramAccount('1784'))?.account_id).toBe('a')
    expect((await findInstagramAccount('app1'))?.account_id).toBe('a')
    expect(await findInstagramAccount('other')).toBeNull()
  })
})

describe('token refresh', () => {
  const now = new Date('2026-11-06T00:00:00Z')
  it('refreshes only tokens older than 30 days and keeps going after a failure', async () => {
    h.db.tables.instagram_accounts.push(
      { account_id: 'old', access_token_enc: 'enc:old', token_refreshed_at: '2026-09-01T00:00:00Z' },
      { account_id: 'dead', access_token_enc: 'enc:dead', token_refreshed_at: '2026-09-02T00:00:00Z' },
      { account_id: 'fresh', access_token_enc: 'enc:fresh', token_refreshed_at: '2026-11-01T00:00:00Z' },
      { account_id: 'off', access_token_enc: null, token_refreshed_at: null },
    )
    replies = (u) => (u.includes('access_token=dead') ? { status: 400, body: { error: { message: 'expired' } } } : { status: 200, body: { access_token: 'new' } })
    expect(await refreshDueInstagramTokens(now)).toEqual({ refreshed: 1, failed: 1 })
    const by = (id: string) => h.db.tables.instagram_accounts.find((r) => r.account_id === id)!
    expect(by('old').access_token_enc).toBe('enc:new')
    expect(by('dead').access_token_enc).toBe('enc:dead')
    expect(by('fresh').access_token_enc).toBe('enc:fresh')
    expect(calls).toHaveLength(2)
  })
})

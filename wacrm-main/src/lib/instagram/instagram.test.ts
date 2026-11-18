import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDb, type MemoryDb } from '@/lib/automations/memory-db.test-helper'

const h = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  sent: [] as { recipient: unknown; text: string }[],
  publicReplies: [] as { commentId: string; text: string }[],
  charges: [] as { source: string; messageKey: string }[],
}))

vi.mock('@/lib/automations/admin-client', () => ({ serviceDb: () => h.db }))
vi.mock('./graph', () => ({
  sendInstagramMessage: vi.fn(async (a: { recipient: unknown; text: string }) => {
    h.sent.push({ recipient: a.recipient, text: a.text })
    return `m_${h.sent.length}`
  }),
  replyToComment: vi.fn(async (a: { commentId: string; text: string }) => {
    h.publicReplies.push(a)
    return 'c_1'
  }),
}))
vi.mock('@/lib/wallet/charge', () => ({
  sendWithCharge: vi.fn(async (a: { charge: { source: string; messageKey: string }; send: () => Promise<string> }) => {
    h.charges.push(a.charge)
    return a.send()
  }),
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: vi.fn(async () => ({ provider: 'openai', model: 'm', apiKey: 'k', systemPrompt: null, embeddingsApiKey: null })) }))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: vi.fn(async () => ['Abacus book costs ₹499']) }))
vi.mock('@/lib/ai/training-server', () => ({ loadTrainingBlock: vi.fn(async () => null) }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: vi.fn(async () => ({ text: 'The abacus book is ₹499 😊', handoff: false, usage: null })) }))

import { parseInstagramWebhook, verifyInstagramSignature, type InstagramEvent } from './webhook'
import { pickInstagramAutomation, type InstagramAutomation } from './rules'
import { processInstagramEvent, type InstagramConnection } from './engine'
import { DEFAULT_INSTAGRAM_AUTOMATIONS, defaultInstagramAutomations } from './defaults'

const IG = '17841400000000000'

describe('webhook parsing', () => {
  it('reads DMs, story mentions, story replies and comments; drops echoes', () => {
    const events = parseInstagramWebhook({
      object: 'instagram',
      entry: [
        {
          id: IG,
          time: 1700000000,
          messaging: [
            { sender: { id: 'u1' }, recipient: { id: IG }, timestamp: 1, message: { mid: 'm1', text: 'price?' } },
            { sender: { id: 'u2' }, recipient: { id: IG }, message: { mid: 'm2', attachments: [{ type: 'story_mention', payload: { url: 'x' } }] } },
            { sender: { id: 'u3' }, recipient: { id: IG }, message: { mid: 'm3', text: 'love it', reply_to: { story: { id: 's1' } } } },
            { sender: { id: IG }, recipient: { id: 'u1' }, message: { mid: 'm4', text: 'our own', is_echo: true } },
          ],
          changes: [{ field: 'comments', value: { id: 'c1', text: 'PRICE pls', from: { id: 'u4', username: 'asha' }, media: { id: 'post1' } } }],
        },
      ],
    })
    expect(events.map((e) => [e.kind, e.senderId, e.mid])).toEqual([
      ['dm', 'u1', 'm1'],
      ['story_mention', 'u2', 'm2'],
      ['story_reply', 'u3', 'm3'],
      ['comment', 'u4', 'c1'],
    ])
    expect(events[3]).toEqual(expect.objectContaining({ username: 'asha', commentId: 'c1', mediaId: 'post1' }))
  })

  it('ignores non-instagram payloads', () => {
    expect(parseInstagramWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual([])
  })

  it('verifies X-Hub-Signature-256 against any configured secret', () => {
    const body = '{"a":1}'
    const sig = 'sha256=' + createHmac('sha256', 'secret-b').update(body).digest('hex')
    expect(verifyInstagramSignature(body, sig, ['secret-a', 'secret-b'])).toBe(true)
    expect(verifyInstagramSignature(body, sig, ['secret-a'])).toBe(false)
    expect(verifyInstagramSignature(body + ' ', sig, ['secret-b'])).toBe(false)
    expect(verifyInstagramSignature(body, null, ['secret-b'])).toBe(false)
  })
})

const auto = (kind: InstagramAutomation['kind'], config: InstagramAutomation['config'], over: Partial<InstagramAutomation> = {}): InstagramAutomation => ({
  id: kind,
  account_id: 'a',
  user_id: 'u',
  kind,
  name: kind,
  is_active: true,
  config,
  priority: 100,
  sent_count: 0,
  ...over,
})
const ev = (kind: InstagramEvent['kind'], text = '', mediaId: string | null = null) => ({ kind, text, mediaId })
// Friday 15:00 IST / 02:00 IST Saturday
const DAY = new Date('2026-11-06T09:30:00Z')
const NIGHT = new Date('2026-11-06T20:30:00Z')

describe('automation precedence', () => {
  const all = [
    auto('keyword', { keywords: ['price'] }),
    auto('welcome', { reply_text: 'hi' }),
    auto('away', { start_time: '21:00', end_time: '09:00', timezone: 'Asia/Kolkata' }),
    auto('story_mention', {}),
    auto('comment_to_dm', { keywords: ['price'], media_id: 'post1' }),
  ]
  it('keyword beats welcome on a first message', () => {
    expect(pickInstagramAutomation(all, ev('dm', 'what is the PRICE'), { isFirstMessage: true, now: DAY })?.kind).toBe('keyword')
  })
  it('welcome only on the first message; away only after hours', () => {
    expect(pickInstagramAutomation(all, ev('dm', 'hello'), { isFirstMessage: true, now: DAY })?.kind).toBe('welcome')
    expect(pickInstagramAutomation(all, ev('dm', 'hello'), { isFirstMessage: false, now: DAY })).toBeNull()
    expect(pickInstagramAutomation(all, ev('dm', 'hello'), { isFirstMessage: false, now: NIGHT })?.kind).toBe('away')
  })
  it('comments only use comment_to_dm, filtered by post and keyword', () => {
    expect(pickInstagramAutomation(all, ev('comment', 'price?', 'post1'), { isFirstMessage: true })?.kind).toBe('comment_to_dm')
    expect(pickInstagramAutomation(all, ev('comment', 'price?', 'post2'), { isFirstMessage: true })).toBeNull()
    expect(pickInstagramAutomation(all, ev('comment', 'nice!', 'post1'), { isFirstMessage: true })).toBeNull()
  })
  it('story mentions use story_mention; inactive automations never fire', () => {
    expect(pickInstagramAutomation(all, ev('story_mention'), { isFirstMessage: true })?.kind).toBe('story_mention')
    expect(pickInstagramAutomation([auto('welcome', {}, { is_active: false })], ev('dm', 'hi'), { isFirstMessage: true })).toBeNull()
  })
})

const ACCOUNT = 'acct'
const connected: InstagramConnection = { accountId: ACCOUNT, igUserId: IG, token: 'tok', aiAutoReply: false }
const simulated: InstagramConnection = { ...connected, token: null }
let n = 0
const event = (kind: InstagramEvent['kind'], text: string, over: Partial<InstagramEvent> = {}): InstagramEvent => {
  n++
  return { kind, igUserId: IG, senderId: 'cust1', username: 'asha', text, mid: `mid${n}`, commentId: kind === 'comment' ? `c${n}` : null, mediaId: null, timestamp: 0, ...over }
}

describe('engine', () => {
  beforeEach(() => {
    h.sent = []
    h.publicReplies = []
    h.charges = []
    h.db = createMemoryDb({
      instagram_accounts: [{ account_id: ACCOUNT }],
      instagram_contacts: [],
      instagram_messages: [],
      quick_replies: [{ id: 'qr1', account_id: ACCOUNT, content_text: 'From quick reply: price list …' }],
      instagram_automations: defaultInstagramAutomations(ACCOUNT, 'u1').map((a, i) => ({ ...a, id: `a${i}`, is_active: true, sent_count: 0 })),
    })
  })
  const outbound = () => h.db.tables.instagram_messages.filter((m) => m.direction === 'outbound')

  it('seeds the five basic automations as drafts', () => {
    expect(DEFAULT_INSTAGRAM_AUTOMATIONS.map((a) => a.kind).sort()).toEqual(['away', 'comment_to_dm', 'keyword', 'story_mention', 'welcome'])
    expect(defaultInstagramAutomations('x', 'y').every((a) => a.is_active === false)).toBe(true)
  })

  it('first DM gets the welcome (charged as workflow) and stores both sides', async () => {
    const r = await processInstagramEvent(ACCOUNT, event('dm', 'hello'), { connection: connected, now: DAY })
    expect(r.reply).toEqual(expect.objectContaining({ by: 'automation', status: 'sent' }))
    expect(h.sent[0]).toEqual({ recipient: { id: 'cust1' }, text: expect.stringContaining('Hi @asha, welcome') })
    expect(h.charges[0].source).toBe('workflow')
    expect(h.db.tables.instagram_messages.map((m) => m.direction)).toEqual(['inbound', 'outbound'])
    expect(h.db.tables.instagram_contacts).toHaveLength(1)
  })

  it('webhook retries are ignored', async () => {
    const e = event('dm', 'hello')
    await processInstagramEvent(ACCOUNT, e, { connection: connected, now: DAY })
    const again = await processInstagramEvent(ACCOUNT, e, { connection: connected, now: DAY })
    expect(again.stored).toBe(false)
    expect(h.sent).toHaveLength(1)
  })

  it('comment keyword → private DM reply to the comment + public reply', async () => {
    const e = event('comment', 'PRICE?')
    await processInstagramEvent(ACCOUNT, e, { connection: connected, now: DAY })
    expect(h.sent[0].recipient).toEqual({ comment_id: e.commentId })
    expect(h.publicReplies[0]).toEqual(expect.objectContaining({ commentId: e.commentId, text: 'Sent you a DM @asha 📩' }))
  })

  it('a quick reply can be the message', async () => {
    h.db.tables.instagram_automations.find((a) => a.kind === 'keyword')!.config = { keywords: ['price'], quick_reply_id: 'qr1' }
    await processInstagramEvent(ACCOUNT, event('dm', 'price?'), { connection: connected, now: DAY })
    expect(h.sent[0].text).toBe('From quick reply: price list …')
  })

  it('away message respects its cooldown', async () => {
    // Row timestamps come from the clock, so freeze it at "night".
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NIGHT)
    await processInstagramEvent(ACCOUNT, event('dm', 'hello'), { connection: connected, now: NIGHT })
    await processInstagramEvent(ACCOUNT, event('dm', 'anyone?'), { connection: connected, now: NIGHT })
    await processInstagramEvent(ACCOUNT, event('dm', 'hello??'), { connection: connected, now: NIGHT })
    // welcome first, then one away, then silence inside the cooldown
    expect(h.sent.map((s) => s.text.slice(0, 12))).toEqual(['Hi @asha, we', 'Thanks for y'])
    vi.useRealTimers()
  })

  it('no automation → AI answers from the knowledge base (charged as ai_agent)', async () => {
    h.db.tables.instagram_automations = []
    const r = await processInstagramEvent(ACCOUNT, event('dm', 'how much is the abacus book'), {
      connection: { ...connected, aiAutoReply: true },
      now: DAY,
    })
    expect(r.reply).toEqual({ by: 'ai', status: 'sent' })
    expect(h.sent[0].text).toBe('The abacus book is ₹499 😊')
    expect(h.charges[0].source).toBe('ai_agent')
  })

  it('simulation mode stores replies without sending or charging', async () => {
    const r = await processInstagramEvent(ACCOUNT, event('story_mention', ''), { connection: simulated, now: DAY })
    expect(r.reply?.status).toBe('simulated')
    expect(h.sent).toEqual([])
    expect(h.charges).toEqual([])
    expect(outbound()[0]).toEqual(expect.objectContaining({ status: 'simulated', sent_by: 'automation' }))
  })

  it('a failed send is recorded, not thrown', async () => {
    const graph = await import('./graph')
    vi.mocked(graph.sendInstagramMessage).mockRejectedValueOnce(new Error('outside 24h window'))
    const r = await processInstagramEvent(ACCOUNT, event('dm', 'hello'), { connection: connected, now: DAY })
    expect(r.reply?.status).toBe('failed')
    expect(outbound()[0]).toEqual(expect.objectContaining({ status: 'failed', error: 'outside 24h window' }))
  })
})

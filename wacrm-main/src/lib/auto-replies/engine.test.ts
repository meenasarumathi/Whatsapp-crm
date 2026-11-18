import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    rules: [] as Record<string, unknown>[],
    contact: { id: 'c1', name: 'Asha', phone: '+919000000001' } as Record<string, unknown> | null,
    contactTags: [] as { tag_id: string }[],
    recentSends: 0,
    inserts: [] as { table: string; payload: unknown }[],
    updates: [] as { table: string; payload: unknown }[],
  },
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
}))

vi.mock('@/lib/automations/admin-client', () => {
  const { state } = h
  function builder(table: string) {
    const ops = { type: 'select', payload: undefined as unknown, head: false }
    const resolve = () => {
      if (ops.type === 'insert') {
        state.inserts.push({ table, payload: ops.payload })
        return { data: null, error: null }
      }
      if (ops.type === 'update') {
        state.updates.push({ table, payload: ops.payload })
        return { data: null, error: null }
      }
      if (table === 'auto_reply_rules') return { data: state.rules, error: null }
      if (table === 'contacts') return { data: state.contact, error: null }
      if (table === 'contact_tags') return { data: state.contactTags, error: null }
      if (table === 'auto_reply_sends') return { data: null, error: null, count: state.recentSends }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {
      select: (_c?: string, opts?: { head?: boolean }) => ((ops.head = Boolean(opts?.head)), b),
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: () => b,
      gte: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, err),
    }
    return b
  }
  return { serviceDb: () => ({ from: builder }) }
})

vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: h.sendText,
  engineSendTemplate: h.sendTemplate,
}))

import { runAutoReplyRules } from './engine'

// Friday 2026-11-06 15:00 IST.
const NOW = new Date('2026-11-06T09:30:00Z')

function rule(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    account_id: 'a1',
    user_id: 'u1',
    name: 'VIP',
    is_active: true,
    tag_ids: ['vip'],
    days: [1, 2, 3, 4, 5],
    start_time: '09:00',
    end_time: '18:00',
    timezone: 'Asia/Kolkata',
    reply_kind: 'text',
    template_name: null,
    template_language: null,
    template_variables: {},
    message_text: 'Hi {{contact.name}}!',
    cooldown_minutes: 720,
    priority: 100,
    sent_count: 4,
    last_sent_at: null,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

const input = { accountId: 'a1', contactId: 'c1', conversationId: 'conv1', inboundMessageId: 'wamid.1', now: NOW }

beforeEach(() => {
  h.state.rules = []
  h.state.contact = { id: 'c1', name: 'Asha', phone: '+919000000001' }
  h.state.contactTags = [{ tag_id: 'vip' }]
  h.state.recentSends = 0
  h.state.inserts = []
  h.state.updates = []
  h.sendText.mockReset().mockResolvedValue({ whatsapp_message_id: 'w1' })
  h.sendTemplate.mockReset().mockResolvedValue({ whatsapp_message_id: 'w2' })
})

describe('runAutoReplyRules', () => {
  it('sends the text reply to a listed contact inside the window and logs it', async () => {
    h.state.rules = [rule()]
    const res = await runAutoReplyRules(input)
    expect(res).toEqual({ ruleId: 'r1', status: 'sent', reason: undefined })
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hi Asha!',
        conversationId: 'conv1',
        charge: { source: 'workflow', messageKey: 'autoreply:r1:wamid.1' },
      }),
    )
    expect(h.state.inserts).toEqual([
      { table: 'auto_reply_sends', payload: expect.objectContaining({ rule_id: 'r1', status: 'sent', contact_id: 'c1' }) },
    ])
    expect(h.state.updates[0]).toEqual({ table: 'auto_reply_rules', payload: expect.objectContaining({ sent_count: 5 }) })
  })

  it('skips contacts not on the list', async () => {
    h.state.rules = [rule()]
    h.state.contactTags = [{ tag_id: 'other' }]
    expect((await runAutoReplyRules(input)).status).toBe('skipped')
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('skips outside the schedule', async () => {
    h.state.rules = [rule({ start_time: '16:00', end_time: '18:00' })]
    expect((await runAutoReplyRules(input)).reason).toBe('no matching rule')
  })

  it('respects the cooldown and does not fall through to another rule', async () => {
    h.state.rules = [rule(), rule({ id: 'r2', tag_ids: [] })]
    h.state.recentSends = 1
    const res = await runAutoReplyRules(input)
    expect(res).toEqual({ ruleId: 'r1', status: 'skipped', reason: 'cooldown' })
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('first matching rule wins', async () => {
    h.state.rules = [rule({ id: 'r0', tag_ids: ['nope'] }), rule({ id: 'r2', tag_ids: [] }), rule({ id: 'r3', tag_ids: [] })]
    expect((await runAutoReplyRules(input)).ruleId).toBe('r2')
    expect(h.sendText).toHaveBeenCalledTimes(1)
  })

  it('sends templates with ordered, filled params', async () => {
    h.state.rules = [
      rule({ reply_kind: 'template', template_name: 'price_list', template_language: 'en', template_variables: { '2': 'Abacus', '1': '{{contact.name}}' } }),
    ]
    await runAutoReplyRules(input)
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'price_list', language: 'en', params: ['Asha', 'Abacus'] }),
    )
  })

  it('logs a failed send without throwing', async () => {
    h.state.rules = [rule()]
    h.sendText.mockRejectedValueOnce(new Error('wallet empty'))
    const res = await runAutoReplyRules(input)
    expect(res.status).toBe('failed')
    expect(h.state.inserts[0].payload).toEqual(expect.objectContaining({ status: 'failed', error: 'wallet empty' }))
    expect(h.state.updates).toEqual([])
  })

  it('refuses a contact outside the account', async () => {
    h.state.rules = [rule()]
    h.state.contact = null
    expect((await runAutoReplyRules(input)).reason).toBe('contact not in account')
  })
})

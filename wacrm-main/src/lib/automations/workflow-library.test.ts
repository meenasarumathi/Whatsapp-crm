import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDb, type MemoryDb } from './memory-db.test-helper'

// Runs every library workflow through the REAL automation engine against an
// in-memory database. Only the WhatsApp provider calls are replaced, so the
// test sees exactly what a customer would receive.

const h = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  sent: [] as { kind: string; text?: string; payload?: unknown; contactId: string }[],
}))

vi.mock('./admin-client', () => ({ serviceDb: () => h.db }))
vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async (a: { text: string; contactId: string }) => {
    h.sent.push({ kind: 'text', text: a.text, contactId: a.contactId })
    return { whatsapp_message_id: 'w' }
  }),
  engineSendTemplate: vi.fn(async (a: { templateName: string; contactId: string }) => {
    h.sent.push({ kind: 'template', text: a.templateName, contactId: a.contactId })
    return { whatsapp_message_id: 'w' }
  }),
  engineSendInteractive: vi.fn(async (a: { payload: { body: string }; contactId: string }) => {
    h.sent.push({ kind: 'interactive', text: a.payload.body, payload: a.payload, contactId: a.contactId })
    return { whatsapp_message_id: 'w' }
  }),
}))

import { pickLeastBusyAgent, resumePendingExecution, runAutomationsForTrigger, triggerMatches } from './engine'
import { insertSteps } from './steps-tree'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { WORKFLOWS, WORKFLOW_BUTTONS, WORKFLOW_TAGS, type WorkflowResources } from './workflow-library'
import { validateDraft } from './workflow-install'
import { WORKFLOW_DRAFT_NAMES } from './workflow-names'
import type { Automation, AutomationTriggerType } from '@/types'

const ACCOUNT = 'acct'
const CONTACT = 'contact-1'

const resources: WorkflowResources = {
  businessName: 'Zenvy Books',
  tags: Object.fromEntries(Object.values(WORKFLOW_TAGS).map((n) => [n, `tag:${n}`])),
  pipelineId: 'pipe-1',
  stages: { 'New enquiry': 'stage-enquiry' },
}

async function installAll() {
  for (const wf of WORKFLOWS) {
    for (const d of wf.build(resources)) {
      const id = `auto:${d.name}`
      h.db.tables.automations.push({
        id,
        account_id: ACCOUNT,
        user_id: 'u1',
        name: d.name,
        trigger_type: d.trigger_type,
        trigger_config: d.trigger_config,
        is_active: true,
      })
      expect(await insertSteps(id, d.steps)).toBeNull()
    }
  }
}

/** What the webhook dispatches for an inbound message (see whatsapp/webhook/route.ts). */
async function inbound(text: string, opts: { first?: boolean; replyId?: string } = {}) {
  const triggers: AutomationTriggerType[] = ['new_message_received', 'keyword_match']
  if (opts.replyId) triggers.push('interactive_reply')
  if (opts.first) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType,
      contactId: CONTACT,
      context: { message_text: text, conversation_id: 'conv-1', interactive_reply_id: opts.replyId },
    })
  }
}

async function tagContact(tagName: string) {
  const tagId = resources.tags[tagName]
  h.db.tables.contact_tags.push({ id: `ct:${tagName}`, contact_id: CONTACT, tag_id: tagId })
  await runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: 'tag_added', contactId: CONTACT, context: { tag_id: tagId } })
}

/** Run every parked Wait as if its time had come (what the scheduler does). */
async function runDueWaits() {
  const pending = h.db.tables.automation_pending_executions.filter((p) => p.status === 'pending')
  for (const p of pending) {
    p.status = 'running'
    await resumePendingExecution(p as Parameters<typeof resumePendingExecution>[0])
  }
}

const tagsOf = () => h.db.tables.contact_tags.filter((t) => t.contact_id === CONTACT).map((t) => t.tag_id)

beforeEach(async () => {
  h.sent = []
  h.db = createMemoryDb({
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Asha', phone: '+919000000001' }],
    tags: Object.values(resources.tags).map((id) => ({ id, account_id: ACCOUNT })),
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, contact_id: CONTACT, assigned_agent_id: null }],
    profiles: [{ id: 'p1', user_id: 'agent-1', account_id: ACCOUNT, account_role: 'agent' }],
    accounts: [{ id: ACCOUNT, default_currency: 'INR' }],
    automations: [],
    automation_steps: [],
    automation_logs: [],
    automation_pending_executions: [],
    contact_tags: [],
    deals: [],
  })
  await installAll()
})

describe('workflow definitions', () => {
  it('there are six workflows and every automation passes activation checks', () => {
    expect(WORKFLOWS).toHaveLength(6)
    for (const wf of WORKFLOWS) for (const d of wf.build(resources)) expect(validateDraft(d), d.name).toEqual([])
  })

  it('every interactive message is within Meta limits', () => {
    const walk = (steps: { step_type: string; step_config: Record<string, unknown> }[]) =>
      steps.filter((s) => s.step_type === 'send_buttons').map((s) => validateInteractivePayload(s.step_config))
    for (const wf of WORKFLOWS) for (const d of wf.build(resources)) for (const r of walk(d.steps)) expect(r.ok, d.name).toBe(true)
  })

  it('automation names are unique and stable (used to detect installs)', () => {
    const names = Object.values(WORKFLOW_DRAFT_NAMES).flat()
    expect(new Set(names).size).toBe(names.length)
    expect(WORKFLOW_DRAFT_NAMES.delivery_feedback).toHaveLength(2)
  })
})

describe('1. welcome & lead capture', () => {
  it('first message: menu, New lead tag, deal in New enquiry', async () => {
    await inbound('Hi', { first: true })
    const menu = h.sent.find((s) => s.kind === 'interactive')
    expect(menu?.text).toContain('Welcome to Zenvy Books')
    expect(tagsOf()).toContain(resources.tags[WORKFLOW_TAGS.newLead])
    expect(h.db.tables.deals).toEqual([
      expect.objectContaining({ pipeline_id: 'pipe-1', stage_id: 'stage-enquiry', contact_id: CONTACT, currency: 'INR' }),
    ])
  })

  it('a later "hi" does not re-run it', async () => {
    await inbound('hi again')
    expect(h.sent).toEqual([])
    expect(h.db.tables.deals).toEqual([])
  })
})

describe('menu buttons chain into the keyword workflows', () => {
  it.each([
    ['View prices', WORKFLOW_BUTTONS.prices, 'price list', WORKFLOW_TAGS.priceEnquiry],
    ['Track my order', WORKFLOW_BUTTONS.track, 'order number', WORKFLOW_TAGS.orderSupport],
    ['Talk to our team', WORKFLOW_BUTTONS.team, 'team will reply', WORKFLOW_TAGS.needsHuman],
  ])('tap "%s"', async (title, id, expectText, expectTag) => {
    await inbound(title, { replyId: id })
    expect(h.sent.map((s) => s.text).join(' | ')).toContain(expectText)
    expect(tagsOf()).toContain(resources.tags[expectTag])
  })
})

describe('2-4. keyword workflows', () => {
  it('price enquiry by typed text', async () => {
    await inbound('What is the cost of the abacus book?')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('price list')
  })

  it('order tracking assigns the conversation', async () => {
    await inbound('where is my order??')
    expect(h.db.tables.conversations[0].assigned_agent_id).toBe('agent-1')
  })

  it('a complaint is handed to a human', async () => {
    await inbound('I got a damaged copy, need refund')
    expect(h.sent[0].text).toContain('team will reply')
    expect(tagsOf()).toContain(resources.tags[WORKFLOW_TAGS.needsHuman])
  })

  it('unrelated text triggers nothing', async () => {
    await inbound('ok thanks')
    expect(h.sent).toEqual([])
  })
})

describe('5. payment reminder', () => {
  it('sends details, then reminds after the wait while still unpaid', async () => {
    await tagContact(WORKFLOW_TAGS.paymentPending)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('complete the payment')
    expect(h.db.tables.automation_pending_executions).toHaveLength(1)
    await runDueWaits()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toContain('Gentle reminder')
  })

  it('skips the reminder once the tag is removed (paid)', async () => {
    await tagContact(WORKFLOW_TAGS.paymentPending)
    h.db.tables.contact_tags = h.db.tables.contact_tags.filter((t) => t.tag_id !== resources.tags[WORKFLOW_TAGS.paymentPending])
    await runDueWaits()
    expect(h.sent).toHaveLength(1)
  })
})

describe('6. delivery feedback', () => {
  it('asks after the wait; "Loved it" thanks + tags; "Not happy" goes to a human', async () => {
    await tagContact(WORKFLOW_TAGS.delivered)
    expect(h.sent).toEqual([])
    await runDueWaits()
    const ask = h.sent.find((s) => s.kind === 'interactive')
    expect(ask?.text).toContain('delivered')

    await inbound('Loved it ⭐', { replyId: WORKFLOW_BUTTONS.feedbackGood })
    expect(h.sent.at(-1)?.text).toContain('review')
    expect(tagsOf()).toContain(resources.tags[WORKFLOW_TAGS.happyCustomer])

    await inbound('Not happy', { replyId: WORKFLOW_BUTTONS.feedbackBad })
    expect(h.sent.at(-1)?.text).toContain('team will reply')
  })
})

describe('round-robin assignment', () => {
  it('picks the agent with the fewest open chats and skips viewers', async () => {
    h.db.tables.profiles.push(
      { id: 'p2', user_id: 'agent-2', account_id: ACCOUNT, account_role: 'agent' },
      { id: 'p3', user_id: 'viewer-1', account_id: ACCOUNT, account_role: 'viewer' },
    )
    h.db.tables.conversations.push(
      { id: 'busy-1', account_id: ACCOUNT, contact_id: 'x', status: 'open', assigned_agent_id: 'agent-1' },
      { id: 'busy-2', account_id: ACCOUNT, contact_id: 'y', status: 'closed', assigned_agent_id: 'agent-2' },
    )
    expect(await pickLeastBusyAgent(ACCOUNT)).toBe('agent-2')
  })
})

describe('trigger matching sanity', () => {
  it('keyword workflows are case-insensitive', () => {
    const price = WORKFLOWS.find((w) => w.key === 'price_enquiry')!.build(resources)[0]
    const auto = { trigger_type: price.trigger_type, trigger_config: price.trigger_config } as unknown as Automation
    expect(triggerMatches(auto, { message_text: 'PRICE please' })).toBe(true)
  })
})

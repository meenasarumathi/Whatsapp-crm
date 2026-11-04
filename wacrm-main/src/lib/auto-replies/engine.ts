// ============================================================
// Scheduled auto-replies engine. Called from the WhatsApp webhook for
// every inbound customer message that no flow consumed. Picks the first
// active rule (by priority) whose contact lists, days and time window
// match and whose cooldown has passed for this contact, sends its
// template or text, and logs the attempt in auto_reply_sends.
//
// Must never throw — the webhook awaits it inside after().
// ============================================================

import { serviceDb } from '@/lib/automations/admin-client'
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send'
import {
  fillContactPlaceholders,
  isWithinSchedule,
  orderedTemplateParams,
  ruleAppliesToTags,
  type AutoReplyRule,
} from './schedule'

export interface AutoReplyInput {
  accountId: string
  contactId: string
  conversationId: string
  /** Meta id of the inbound message; makes the wallet charge idempotent. */
  inboundMessageId?: string | null
  now?: Date
}

export interface AutoReplyResult {
  ruleId: string | null
  status: 'sent' | 'failed' | 'skipped'
  reason?: string
}

export async function runAutoReplyRules(input: AutoReplyInput): Promise<AutoReplyResult> {
  try {
    const db = serviceDb()
    const now = input.now ?? new Date()

    const { data: rules, error } = await db
      .from('auto_reply_rules')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('is_active', true)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[auto-replies] rules fetch failed:', error)
      return { ruleId: null, status: 'skipped', reason: 'fetch failed' }
    }
    const active = (rules ?? []) as AutoReplyRule[]
    if (active.length === 0) return { ruleId: null, status: 'skipped', reason: 'no rules' }

    // The contact must belong to this account (service connection bypasses RLS).
    const { data: contact } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle()
    if (!contact) return { ruleId: null, status: 'skipped', reason: 'contact not in account' }

    const { data: tagRows } = await db
      .from('contact_tags')
      .select('tag_id')
      .eq('contact_id', input.contactId)
    const contactTags = ((tagRows ?? []) as { tag_id: string }[]).map((r) => r.tag_id)

    for (const rule of active) {
      if (!ruleAppliesToTags(rule, contactTags)) continue
      if (!isWithinSchedule(rule, now)) continue

      if (rule.cooldown_minutes > 0) {
        const since = new Date(now.getTime() - rule.cooldown_minutes * 60_000).toISOString()
        const { count } = await db
          .from('auto_reply_sends')
          .select('id', { count: 'exact', head: true })
          .eq('rule_id', rule.id)
          .eq('contact_id', input.contactId)
          .eq('status', 'sent')
          .gte('created_at', since)
        // The contact already got this reply recently; a lower-priority
        // rule must not answer instead.
        if ((count ?? 0) > 0) return { ruleId: rule.id, status: 'skipped', reason: 'cooldown' }
      }

      return await sendRule(rule, input, contact as { id: string; name: string | null; phone: string })
    }
    return { ruleId: null, status: 'skipped', reason: 'no matching rule' }
  } catch (err) {
    console.error('[auto-replies] dispatch failed:', err)
    return { ruleId: null, status: 'failed', reason: err instanceof Error ? err.message : 'error' }
  }
}

async function sendRule(
  rule: AutoReplyRule,
  input: AutoReplyInput,
  contact: { id: string; name: string | null; phone: string },
): Promise<AutoReplyResult> {
  const db = serviceDb()
  const messageKey = `autoreply:${rule.id}:${input.inboundMessageId ?? globalThis.crypto.randomUUID()}`
  const common = {
    accountId: input.accountId,
    userId: rule.user_id,
    conversationId: input.conversationId,
    contactId: input.contactId,
    charge: { source: 'workflow' as const, messageKey },
  }
  let status: 'sent' | 'failed' = 'sent'
  let errorText: string | null = null
  try {
    if (rule.reply_kind === 'template') {
      if (!rule.template_name) throw new Error('rule has no template')
      await engineSendTemplate({
        ...common,
        templateName: rule.template_name,
        language: rule.template_language ?? undefined,
        params: orderedTemplateParams(rule.template_variables ?? {}, contact),
      })
    } else {
      if (!rule.message_text) throw new Error('rule has no message text')
      await engineSendText({ ...common, text: fillContactPlaceholders(rule.message_text, contact) })
    }
  } catch (err) {
    status = 'failed'
    errorText = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    console.error('[auto-replies] send failed:', rule.id, errorText)
  }

  await db.from('auto_reply_sends').insert({
    rule_id: rule.id,
    account_id: input.accountId,
    contact_id: input.contactId,
    status,
    error: errorText,
  })
  if (status === 'sent') {
    await db
      .from('auto_reply_rules')
      .update({ sent_count: rule.sent_count + 1, last_sent_at: new Date().toISOString() })
      .eq('id', rule.id)
  }
  return { ruleId: rule.id, status, reason: errorText ?? undefined }
}

// ============================================================
// Instagram engine: store an inbound event, then answer it with the
// first matching automation or (when switched on) an AI reply grounded
// in Train AI + the knowledge base.
//
// Sending: with a saved token the reply goes through the Instagram API
// inside sendWithCharge (automations = 'workflow', AI = 'ai_agent', same
// token wallet as WhatsApp). Without a token the channel is in
// simulation mode: the reply is stored as 'simulated', nothing is sent
// or charged — so the tab can be set up and tested before Meta review.
//
// Never throws: the webhook awaits it inside after().
// ============================================================

import { serviceDb } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendWithCharge } from '@/lib/wallet/charge'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { loadTrainingBlock } from '@/lib/ai/training-server'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { generateReply } from '@/lib/ai/generate'
import type { ChatMessage } from '@/lib/ai/types'
import { replyToComment, sendInstagramMessage, type DmRecipient } from './graph'
import { fillInstagramPlaceholders, pickInstagramAutomation, type InstagramAutomation } from './rules'
import type { InstagramEvent } from './webhook'

export interface InstagramConnection {
  accountId: string
  igUserId: string | null
  token: string | null
  aiAutoReply: boolean
}

export interface ProcessResult {
  stored: boolean
  reply: { by: 'automation' | 'ai'; status: 'sent' | 'simulated' | 'failed'; automationId?: string } | null
}

export async function loadInstagramConnection(accountId: string): Promise<InstagramConnection> {
  const { data } = await serviceDb()
    .from('instagram_accounts')
    .select('account_id, ig_user_id, access_token_enc, ai_auto_reply')
    .eq('account_id', accountId)
    .maybeSingle()
  const row = data as { ig_user_id: string | null; access_token_enc: string | null; ai_auto_reply: boolean } | null
  let token: string | null = null
  if (row?.access_token_enc) {
    try {
      token = decrypt(row.access_token_enc)
    } catch (err) {
      console.error('[instagram] token decrypt failed (ENCRYPTION_KEY changed?):', err)
    }
  }
  return { accountId, igUserId: row?.ig_user_id ?? null, token, aiAutoReply: row?.ai_auto_reply ?? false }
}

/** Stores the outbound row and, when connected, sends it (charged). */
export async function sendInstagramReply(args: {
  conn: InstagramConnection
  contactId: string
  recipient: DmRecipient
  text: string
  sentBy: 'agent' | 'automation' | 'ai'
  kind?: 'dm' | 'comment_reply'
  automationId?: string | null
  /** Logical key for the wallet; omit for manual agent replies (free). */
  chargeKey?: { source: 'workflow' | 'ai_agent'; key: string } | null
  commentIdForPublicReply?: string | null
}): Promise<'sent' | 'simulated' | 'failed'> {
  const db = serviceDb()
  const { conn } = args
  let status: 'sent' | 'simulated' | 'failed' = 'simulated'
  let mid: string | null = null
  let error: string | null = null

  if (conn.token && conn.igUserId) {
    const token = conn.token
    const igUserId = conn.igUserId
    const doSend = () =>
      args.commentIdForPublicReply
        ? replyToComment({ token, commentId: args.commentIdForPublicReply, text: args.text })
        : sendInstagramMessage({ token, igUserId, recipient: args.recipient, text: args.text })
    try {
      mid = args.chargeKey
        ? await sendWithCharge({
            accountId: conn.accountId,
            charge: { source: args.chargeKey.source, messageKey: args.chargeKey.key },
            send: doSend,
          })
        : await doSend()
      status = 'sent'
    } catch (err) {
      status = 'failed'
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      console.error('[instagram] send failed:', error)
    }
  }

  await db.from('instagram_messages').insert({
    account_id: conn.accountId,
    contact_id: args.contactId,
    direction: 'outbound',
    kind: args.kind ?? 'dm',
    text: args.text,
    mid: mid || null,
    status,
    error,
    sent_by: args.sentBy,
    automation_id: args.automationId ?? null,
  })
  await db
    .from('instagram_contacts')
    .update({ last_message_text: args.text, last_message_at: new Date().toISOString() })
    .eq('id', args.contactId)
  return status
}

async function resolveReplyText(accountId: string, a: InstagramAutomation, username: string | null): Promise<string> {
  let text = a.config.reply_text ?? ''
  if (a.config.quick_reply_id) {
    const { data } = await serviceDb()
      .from('quick_replies')
      .select('content_text')
      .eq('id', a.config.quick_reply_id)
      .eq('account_id', accountId)
      .maybeSingle()
    text = (data as { content_text?: string } | null)?.content_text || text
  }
  return fillInstagramPlaceholders(text, username).trim()
}

async function upsertContact(accountId: string, event: InstagramEvent, preview: string): Promise<{ id: string; username: string | null }> {
  const db = serviceDb()
  const { data: existing } = await db
    .from('instagram_contacts')
    .select('id, username, unread_count')
    .eq('account_id', accountId)
    .eq('igsid', event.senderId)
    .maybeSingle()
  const now = new Date().toISOString()
  if (existing) {
    const row = existing as { id: string; username: string | null; unread_count: number }
    await db
      .from('instagram_contacts')
      .update({
        last_message_text: preview,
        last_message_at: now,
        unread_count: (row.unread_count ?? 0) + 1,
        ...(event.username && !row.username ? { username: event.username } : {}),
      })
      .eq('id', row.id)
    return { id: row.id, username: row.username ?? event.username }
  }
  const { data: created, error } = await db
    .from('instagram_contacts')
    .insert({
      account_id: accountId,
      igsid: event.senderId,
      username: event.username,
      last_message_text: preview,
      last_message_at: now,
      unread_count: 1,
    })
    .select('id, username')
    .single()
  if (error || !created) throw new Error(`contact insert failed: ${error?.message}`)
  return created as { id: string; username: string | null }
}

async function aiReply(conn: InstagramConnection, contactId: string, latest: string): Promise<string | null> {
  const db = serviceDb()
  const config = await loadAiConfig(db, conn.accountId)
  if (!config) return null
  const { data: history } = await db
    .from('instagram_messages')
    .select('direction, text, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(20)
  const messages: ChatMessage[] = ((history ?? []) as { direction: string; text: string | null }[])
    .filter((m) => m.text)
    .reverse()
    .map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.text as string }))
  const [knowledge, training] = await Promise.all([
    retrieveKnowledge(db, conn.accountId, config, latest),
    loadTrainingBlock(db, conn.accountId, latest),
  ])
  const systemPrompt = buildSystemPrompt({
    userPrompt: [config.systemPrompt, 'This conversation is on Instagram Direct, not WhatsApp. Keep replies short and friendly.']
      .filter(Boolean)
      .join('\n\n'),
    mode: 'auto_reply',
    knowledge,
    training,
  })
  const result = await generateReply({ config, systemPrompt, messages })
  if (result.handoff || !result.text) return null
  return result.text
}

export async function processInstagramEvent(
  accountId: string,
  event: InstagramEvent,
  opts: { now?: Date; connection?: InstagramConnection } = {},
): Promise<ProcessResult> {
  try {
    const db = serviceDb()
    const conn = opts.connection ?? (await loadInstagramConnection(accountId))

    // Webhook retries: Meta re-sends until it gets a 200.
    const { data: dupe } = await db
      .from('instagram_messages')
      .select('id')
      .eq('account_id', accountId)
      .eq('mid', event.mid)
      .maybeSingle()
    if (dupe) return { stored: false, reply: null }

    const preview = event.kind === 'story_mention' ? '📸 Mentioned you in a story' : event.text
    const contact = await upsertContact(accountId, event, preview)
    const { count: priorInbound } = await db
      .from('instagram_messages')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contact.id)
      .eq('direction', 'inbound')

    await db.from('instagram_messages').insert({
      account_id: accountId,
      contact_id: contact.id,
      direction: 'inbound',
      kind: event.kind,
      text: event.text || null,
      mid: event.mid,
      comment_id: event.commentId,
      media_id: event.mediaId,
      status: 'received',
    })
    await db.from('instagram_accounts').update({ last_event_at: new Date().toISOString() }).eq('account_id', accountId)

    const { data: rows } = await db.from('instagram_automations').select('*').eq('account_id', accountId).eq('is_active', true)
    const automation = pickInstagramAutomation((rows ?? []) as InstagramAutomation[], event, {
      isFirstMessage: (priorInbound ?? 0) === 0,
      now: opts.now,
    })

    const dmRecipient: DmRecipient = event.kind === 'comment' && event.commentId ? { comment_id: event.commentId } : { id: event.senderId }

    if (automation) {
      // Away messages respect a per-contact cooldown so a chatty night
      // owl isn't told "we're closed" on every message.
      if (automation.kind === 'away' && (automation.config.cooldown_minutes ?? 720) > 0) {
        const since = new Date((opts.now ?? new Date()).getTime() - (automation.config.cooldown_minutes ?? 720) * 60_000).toISOString()
        const { count } = await db
          .from('instagram_messages')
          .select('id', { count: 'exact', head: true })
          .eq('contact_id', contact.id)
          .eq('automation_id', automation.id)
          .gte('created_at', since)
        if ((count ?? 0) > 0) return { stored: true, reply: null }
      }
      const text = await resolveReplyText(accountId, automation, contact.username ?? event.username)
      if (!text) return { stored: true, reply: null }
      const status = await sendInstagramReply({
        conn,
        contactId: contact.id,
        recipient: dmRecipient,
        text,
        sentBy: 'automation',
        automationId: automation.id,
        chargeKey: { source: 'workflow', key: `ig:${automation.id}:${event.mid}` },
      })
      if (automation.kind === 'comment_to_dm' && automation.config.public_reply && event.commentId) {
        await sendInstagramReply({
          conn,
          contactId: contact.id,
          recipient: dmRecipient,
          text: fillInstagramPlaceholders(automation.config.public_reply, contact.username ?? event.username),
          sentBy: 'automation',
          kind: 'comment_reply',
          automationId: automation.id,
          chargeKey: { source: 'workflow', key: `ig:${automation.id}:${event.mid}:public` },
          commentIdForPublicReply: event.commentId,
        })
      }
      if (status !== 'failed') {
        await db
          .from('instagram_automations')
          .update({ sent_count: (automation.sent_count ?? 0) + 1, last_sent_at: new Date().toISOString() })
          .eq('id', automation.id)
      }
      return { stored: true, reply: { by: 'automation', status, automationId: automation.id } }
    }

    // AI fallback: DMs with text only (never public comments).
    if (conn.aiAutoReply && (event.kind === 'dm' || event.kind === 'story_reply') && event.text.trim()) {
      const text = await aiReply(conn, contact.id, event.text)
      if (!text) return { stored: true, reply: null }
      const status = await sendInstagramReply({
        conn,
        contactId: contact.id,
        recipient: dmRecipient,
        text,
        sentBy: 'ai',
        chargeKey: { source: 'ai_agent', key: `ig-ai:${event.mid}` },
      })
      return { stored: true, reply: { by: 'ai', status } }
    }
    return { stored: true, reply: null }
  } catch (err) {
    console.error('[instagram] process failed:', err)
    return { stored: false, reply: null }
  }
}

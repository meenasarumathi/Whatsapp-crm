// ============================================================
// Which Instagram automation answers an event. Pure, unit-tested.
//
// Precedence (first hit wins, one automated reply per event):
//   comment        → comment_to_dm (keywords + optional post filter)
//   story mention  → story_mention
//   DM / story reply → keyword → welcome (first message only) → away (inside its hours)
// Nothing matched → the caller may fall back to the AI reply.
// ============================================================

import { isWithinSchedule } from '@/lib/auto-replies/schedule'
import type { InstagramEvent } from './webhook'

export type InstagramAutomationKind = 'welcome' | 'keyword' | 'comment_to_dm' | 'story_mention' | 'away'

export interface InstagramAutomationConfig {
  keywords?: string[]
  match?: 'contains' | 'exact'
  /** DM text; {{name}} becomes the customer's @username or "there". */
  reply_text?: string
  /** Use a saved Quick reply as the DM text instead of reply_text. */
  quick_reply_id?: string | null
  /** comment_to_dm: optional public reply posted under the comment. */
  public_reply?: string
  /** comment_to_dm: only comments on this post (media id). */
  media_id?: string | null
  /** away: schedule (same semantics as scheduled auto-replies). */
  days?: number[]
  start_time?: string
  end_time?: string
  timezone?: string
  cooldown_minutes?: number
}

export interface InstagramAutomation {
  id: string
  account_id: string
  user_id: string
  kind: InstagramAutomationKind
  name: string
  is_active: boolean
  config: InstagramAutomationConfig
  priority: number
  sent_count: number
}

export function keywordHit(text: string, cfg: InstagramAutomationConfig): boolean {
  const keywords = (cfg.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean)
  if (keywords.length === 0) return false
  const t = text.trim().toLowerCase()
  return cfg.match === 'exact' ? keywords.includes(t) : keywords.some((k) => t.includes(k))
}

export function pickInstagramAutomation(
  automations: InstagramAutomation[],
  event: Pick<InstagramEvent, 'kind' | 'text' | 'mediaId'>,
  ctx: { isFirstMessage: boolean; now?: Date },
): InstagramAutomation | null {
  const active = automations.filter((a) => a.is_active).sort((a, b) => a.priority - b.priority)
  const of = (kind: InstagramAutomationKind) => active.filter((a) => a.kind === kind)

  if (event.kind === 'comment') {
    return (
      of('comment_to_dm').find((a) => {
        if (a.config.media_id && a.config.media_id !== event.mediaId) return false
        // No keywords = every comment on the (filtered) post.
        return (a.config.keywords ?? []).filter(Boolean).length === 0 || keywordHit(event.text, a.config)
      }) ?? null
    )
  }
  if (event.kind === 'story_mention') return of('story_mention')[0] ?? null

  const keyword = of('keyword').find((a) => keywordHit(event.text, a.config))
  if (keyword) return keyword
  if (ctx.isFirstMessage) {
    const welcome = of('welcome')[0]
    if (welcome) return welcome
  }
  return (
    of('away').find((a) =>
      isWithinSchedule(
        {
          days: a.config.days ?? [0, 1, 2, 3, 4, 5, 6],
          start_time: a.config.start_time ?? '21:00',
          end_time: a.config.end_time ?? '09:00',
          timezone: a.config.timezone ?? 'Asia/Kolkata',
        },
        ctx.now ?? new Date(),
      ),
    ) ?? null
  )
}

export function fillInstagramPlaceholders(text: string, username: string | null): string {
  return text.replace(/\{\{\s*name\s*\}\}/g, username ? `@${username}` : 'there')
}

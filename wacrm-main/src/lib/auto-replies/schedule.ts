// ============================================================
// Pure helpers for scheduled auto-reply rules: is "now" inside a rule's
// days + time window (in the rule's own timezone), and does a rule apply
// to a contact's tags. No I/O, so the engine and the UI share them and
// they are unit-tested directly.
// ============================================================

export interface AutoReplyRule {
  id: string
  account_id: string
  user_id: string
  name: string
  is_active: boolean
  /** Contact lists (tags). Empty = the rule applies to every contact. */
  tag_ids: string[]
  /** 0 = Sunday … 6 = Saturday, in the rule's timezone. */
  days: number[]
  /** "HH:mm". When end < start the window runs past midnight. */
  start_time: string
  end_time: string
  timezone: string
  reply_kind: 'template' | 'text'
  template_name: string | null
  template_language: string | null
  /** Template placeholder number → value; may contain {{contact.name}}. */
  template_variables: Record<string, string>
  message_text: string | null
  cooldown_minutes: number
  priority: number
  sent_count: number
  last_sent_at: string | null
  created_at: string
  updated_at: string
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Day of week and minute of day of `at` in `timeZone`. Unknown zones fall back to UTC. */
export function localClock(at: Date, timeZone: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at)
  } catch {
    return localClock(at, 'UTC')
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    day: WEEKDAY[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

/**
 * Whether `at` falls inside the rule's window. The day that counts is the
 * day the window STARTED on, so a Friday 18:00–09:00 rule still answers
 * at 02:00 on Saturday. start == end means all day.
 */
export function isWithinSchedule(
  rule: Pick<AutoReplyRule, 'days' | 'start_time' | 'end_time' | 'timezone'>,
  at: Date = new Date(),
): boolean {
  const start = toMinutes(rule.start_time)
  const end = toMinutes(rule.end_time)
  if (start === null || end === null || rule.days.length === 0) return false
  const { day, minutes } = localClock(at, rule.timezone)
  if (start === end) return rule.days.includes(day)
  if (start < end) return rule.days.includes(day) && minutes >= start && minutes < end
  // Over midnight: the evening part belongs to today, the early-morning
  // part to the day before.
  if (minutes >= start) return rule.days.includes(day)
  if (minutes < end) return rule.days.includes((day + 6) % 7)
  return false
}

/** A rule with no lists applies to everyone; otherwise the contact needs one of its lists. */
export function ruleAppliesToTags(rule: Pick<AutoReplyRule, 'tag_ids'>, contactTagIds: Iterable<string>): boolean {
  if (rule.tag_ids.length === 0) return true
  const have = new Set(contactTagIds)
  return rule.tag_ids.some((id) => have.has(id))
}

/** Fills {{contact.name}} / {{contact.phone}} in a template variable or text reply. */
export function fillContactPlaceholders(text: string, contact: { name?: string | null; phone?: string | null }): string {
  return text.replace(/\{\{\s*contact\.(name|phone)\s*\}\}/g, (_, key: string) =>
    String((key === 'name' ? contact.name : contact.phone) ?? '').trim() || (key === 'name' ? 'there' : ''),
  )
}

/** Template params in strict numeric order ({{1}}, {{2}}, …, {{10}}). */
export function orderedTemplateParams(
  variables: Record<string, string>,
  contact: { name?: string | null; phone?: string | null },
): string[] {
  return Object.keys(variables)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => fillContactPlaceholders(String(variables[k] ?? ''), contact))
}

/**
 * Normalises pasted / CSV phone numbers to digits with country code.
 * A 10-digit number gets `defaultCountryCode` (e.g. "91"). Returns null
 * for anything that can't be a phone number.
 */
export function normalizePhone(raw: string, defaultCountryCode = '91'): string | null {
  const digits = raw.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
  let d = digits.startsWith('+') ? digits.slice(1) : digits.replace(/^00/, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10 && !digits.startsWith('+')) d = defaultCountryCode + d
  return d.length >= 8 && d.length <= 15 ? d : null
}

/** Splits pasted text or CSV into phone numbers (+ optional name per line). Deduplicated.
 *  Accepts one number per line, several per line separated by commas /
 *  semicolons / tabs, and CSV rows like "Asha,98765 43210". */
export function parseNumberList(input: string, defaultCountryCode = '91'): { phone: string; name: string | null }[] {
  const seen = new Set<string>()
  const out: { phone: string; name: string | null }[] = []
  const looksLikePhone = (c: string) => c.replace(/\D/g, '').length >= 8
  for (const line of input.split(/\r?\n/)) {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '').trim())
    const phones = cells
      .filter(looksLikePhone)
      .map((c) => normalizePhone(c, defaultCountryCode))
      .filter((p): p is string => p !== null)
    // A name only makes sense next to a single number on the line.
    const name = phones.length === 1 ? (cells.find((c) => c && !/\d{5,}/.test(c)) ?? null) : null
    for (const phone of phones) {
      if (seen.has(phone)) continue
      seen.add(phone)
      out.push({ phone, name })
    }
  }
  return out
}

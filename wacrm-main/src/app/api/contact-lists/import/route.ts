import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseNumberList } from '@/lib/auto-replies/schedule'

const MAX_NUMBERS = 5000
const CHUNK = 200

/**
 * Fill a contact list from pasted / CSV numbers.
 *
 * Body: { tag_id?: string, name?: string, numbers: string, country_code?: string }
 * - `name` creates a new list (a tag with is_list = true); `tag_id` adds to an existing one.
 * - Numbers that match an existing contact (by digits) reuse it; the rest become new contacts.
 * - Tags are written directly, NOT through addContactTagAndDispatch: importing a list must not
 *   fire "Tag added" automations for hundreds of contacts at once.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as {
      tag_id?: unknown
      name?: unknown
      numbers?: unknown
      country_code?: unknown
    } | null
    const numbers = typeof body?.numbers === 'string' ? body.numbers : ''
    const countryCode =
      typeof body?.country_code === 'string' && /^\d{1,4}$/.test(body.country_code) ? body.country_code : '91'
    const parsed = parseNumberList(numbers, countryCode)
    if (parsed.length === 0) {
      return NextResponse.json({ error: 'No valid phone numbers found' }, { status: 400 })
    }
    if (parsed.length > MAX_NUMBERS) {
      return NextResponse.json({ error: `At most ${MAX_NUMBERS} numbers per import` }, { status: 400 })
    }

    // Resolve or create the list.
    let tagId = typeof body?.tag_id === 'string' && body.tag_id.trim() ? body.tag_id.trim() : null
    if (tagId) {
      const { data: tag } = await ctx.db.from('tags').select('id').eq('id', tagId).eq('account_id', ctx.accountId).maybeSingle()
      if (!tag) return NextResponse.json({ error: 'List not found' }, { status: 404 })
      await ctx.db.from('tags').update({ is_list: true }).eq('id', tagId)
    } else {
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
      if (!name) return NextResponse.json({ error: 'List name is required' }, { status: 400 })
      const { data: existing } = await ctx.db
        .from('tags')
        .select('id')
        .eq('account_id', ctx.accountId)
        .ilike('name', name)
        .maybeSingle()
      if (existing) {
        tagId = (existing as { id: string }).id
        await ctx.db.from('tags').update({ is_list: true }).eq('id', tagId)
      } else {
        const { data: created, error } = await ctx.db
          .from('tags')
          .insert({ user_id: ctx.userId, account_id: ctx.accountId, name, color: '#0d9488', is_list: true })
          .select('id')
          .single()
        if (error || !created) throw new Error(error?.message ?? 'Could not create the list')
        tagId = (created as { id: string }).id
      }
    }

    let createdContacts = 0
    let added = 0
    for (let i = 0; i < parsed.length; i += CHUNK) {
      const chunk = parsed.slice(i, i + CHUNK)
      const { data: found, error: findErr } = await ctx.db
        .from('contacts')
        .select('id, phone_normalized')
        .eq('account_id', ctx.accountId)
        .in('phone_normalized', chunk.map((c) => c.phone))
      if (findErr) throw new Error(findErr.message)
      const byPhone = new Map(((found ?? []) as { id: string; phone_normalized: string }[]).map((c) => [c.phone_normalized, c.id]))

      const missing = chunk.filter((c) => !byPhone.has(c.phone))
      if (missing.length > 0) {
        const { data: inserted, error: insErr } = await ctx.db
          .from('contacts')
          .insert(missing.map((c) => ({ user_id: ctx.userId, account_id: ctx.accountId, phone: `+${c.phone}`, name: c.name })))
          .select('id, phone_normalized')
        if (insErr) throw new Error(insErr.message)
        for (const c of (inserted ?? []) as { id: string; phone_normalized: string }[]) byPhone.set(c.phone_normalized, c.id)
        createdContacts += inserted?.length ?? 0
      }

      const rows = chunk.map((c) => byPhone.get(c.phone)).filter(Boolean).map((contactId) => ({ contact_id: contactId, tag_id: tagId }))
      const { data: tagged, error: tagErr } = await ctx.db
        .from('contact_tags')
        .upsert(rows, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
        .select('id')
      if (tagErr) throw new Error(tagErr.message)
      added += tagged?.length ?? 0
    }

    return NextResponse.json({ ok: true, tag_id: tagId, numbers: parsed.length, created_contacts: createdContacts, added })
  } catch (error) {
    return toErrorResponse(error)
  }
}

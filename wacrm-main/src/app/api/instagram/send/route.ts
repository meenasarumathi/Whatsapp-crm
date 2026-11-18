import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { serviceDb } from '@/lib/automations/admin-client'
import { loadInstagramConnection, sendInstagramReply } from '@/lib/instagram/engine'

/** Manual reply from the Instagram inbox. Body: { contact_id, text }. Free (no token charge). */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as { contact_id?: unknown; text?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (typeof body?.contact_id !== 'string' || !text) {
      return NextResponse.json({ error: 'contact_id and text required' }, { status: 400 })
    }
    const { data: contact } = await serviceDb()
      .from('instagram_contacts')
      .select('id, igsid')
      .eq('id', body.contact_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    const conn = await loadInstagramConnection(ctx.accountId)
    const status = await sendInstagramReply({
      conn,
      contactId: (contact as { id: string }).id,
      recipient: { id: (contact as { igsid: string }).igsid },
      text: text.slice(0, 1000),
      sentBy: 'agent',
    })
    await serviceDb().from('instagram_contacts').update({ unread_count: 0 }).eq('id', (contact as { id: string }).id)
    if (status === 'failed') {
      return NextResponse.json({ status, error: 'Instagram did not accept the message (outside the 24-hour window or token expired).' }, { status: 502 })
    }
    return NextResponse.json({ status })
  } catch (error) {
    return toErrorResponse(error)
  }
}

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { refreshDueInstagramTokens } from '@/lib/instagram/connection'

/** Keeps Instagram tokens alive. Same `x-cron-secret` as the other crons. */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await refreshDueInstagramTokens())
}

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { WORKFLOWS } from '@/lib/automations/workflow-library'
import { WORKFLOW_DRAFT_NAMES } from '@/lib/automations/workflow-names'
import { WorkflowInstallError, installWorkflow } from '@/lib/automations/workflow-install'

/** Which library workflows are already installed in the caller's account. */
export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const { data } = await ctx.db.from('automations').select('id, name, is_active').eq('account_id', ctx.accountId)
    const byName = new Map(((data ?? []) as { id: string; name: string; is_active: boolean }[]).map((a) => [a.name, a]))
    return NextResponse.json({
      workflows: WORKFLOWS.map((w) => {
        const installed = WORKFLOW_DRAFT_NAMES[w.key].map((n) => byName.get(n)).filter(Boolean)
        return { key: w.key, installed: installed.length > 0, automations: installed }
      }),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Body: { key: WorkflowKey, activate?: boolean } */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as { key?: unknown; activate?: unknown } | null
    if (typeof body?.key !== 'string') return NextResponse.json({ error: 'key required' }, { status: 400 })
    const result = await installWorkflow(
      { db: ctx.db, userId: ctx.userId, accountId: ctx.accountId, accountName: ctx.account.name },
      body.key,
      body.activate === true,
    )
    return NextResponse.json(result, { status: result.created.length > 0 ? 201 : 200 })
  } catch (error) {
    if (error instanceof WorkflowInstallError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}

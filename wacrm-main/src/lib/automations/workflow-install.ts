// ============================================================
// Installs a workflow from the library into an account: creates the tags
// it needs, makes sure the "Lead to Settlement" pipeline exists, then
// writes the automations + steps (validated like a normal activation).
// Re-installing skips automations that already exist by name.
// ============================================================

import type { DbClient } from '@/lib/db'
import { templateStageRows } from '@/lib/pipelines/templates'
import { serviceDb } from './admin-client'
import { insertSteps } from './steps-tree'
import { validateStepsForActivation, validateTriggerForActivation, type ValidationIssue } from './validate'
import {
  SETTLEMENT_PIPELINE_NAME,
  getWorkflow,
  type WorkflowAutomationDraft,
  type WorkflowResources,
} from './workflow-library'

export class WorkflowInstallError extends Error {
  constructor(message: string, readonly status = 400, readonly issues: ValidationIssue[] = []) {
    super(message)
  }
}

export interface InstallContext {
  /** Caller-scoped client (RLS): tags and the pipeline are created as the user. */
  db: DbClient
  userId: string
  accountId: string
  accountName: string
}

export interface InstallResult {
  created: { id: string; name: string }[]
  skipped: string[]
}

export function validateDraft(d: WorkflowAutomationDraft): ValidationIssue[] {
  return [
    ...validateTriggerForActivation(d.trigger_type, d.trigger_config),
    ...validateStepsForActivation(d.steps as unknown as Parameters<typeof validateStepsForActivation>[0]),
  ]
}

async function ensureTags(ctx: InstallContext, names: string[]): Promise<Record<string, string>> {
  const { data } = await ctx.db.from('tags').select('id, name').eq('account_id', ctx.accountId)
  const byName = new Map(((data ?? []) as { id: string; name: string }[]).map((t) => [t.name.toLowerCase(), t.id]))
  const out: Record<string, string> = {}
  for (const name of names) {
    let id = byName.get(name.toLowerCase())
    if (!id) {
      const { data: created, error } = await ctx.db
        .from('tags')
        .insert({ user_id: ctx.userId, account_id: ctx.accountId, name, color: '#0d9488' })
        .select('id')
        .single()
      if (error || !created) throw new WorkflowInstallError(`Could not create tag "${name}": ${error?.message ?? ''}`, 500)
      id = (created as { id: string }).id
    }
    out[name] = id
  }
  return out
}

async function ensureSettlementPipeline(ctx: InstallContext): Promise<{ pipelineId: string; stages: Record<string, string> }> {
  const { data: existing } = await ctx.db
    .from('pipelines')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', SETTLEMENT_PIPELINE_NAME)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  let pipelineId = (existing as { id: string } | null)?.id
  if (!pipelineId) {
    const { data: created, error } = await ctx.db
      .from('pipelines')
      .insert({ user_id: ctx.userId, account_id: ctx.accountId, name: SETTLEMENT_PIPELINE_NAME })
      .select('id')
      .single()
    if (error || !created) {
      throw new WorkflowInstallError(
        'This workflow needs the "Lead to Settlement" pipeline. Ask an admin to install it once, or create that pipeline in Pipelines.',
        403,
      )
    }
    pipelineId = (created as { id: string }).id
    const { error: stageErr } = await ctx.db.from('pipeline_stages').insert(templateStageRows(pipelineId, 'settlement'))
    if (stageErr) throw new WorkflowInstallError(`Could not create the pipeline stages: ${stageErr.message}`, 500)
  }
  const { data: stageRows } = await ctx.db.from('pipeline_stages').select('id, name').eq('pipeline_id', pipelineId)
  const stages = Object.fromEntries(((stageRows ?? []) as { id: string; name: string }[]).map((s) => [s.name, s.id]))
  if (!stages['New enquiry']) {
    throw new WorkflowInstallError('The "Lead to Settlement" pipeline has no "New enquiry" stage. Rename a stage back or recreate the pipeline.', 409)
  }
  return { pipelineId, stages }
}

async function businessName(ctx: InstallContext): Promise<string> {
  const { data } = await ctx.db.from('ai_training_profiles').select('profile').eq('account_id', ctx.accountId).maybeSingle()
  const fromTraining = (data as { profile?: { businessName?: string } } | null)?.profile?.businessName?.trim()
  return fromTraining || ctx.accountName || 'our store'
}

export async function installWorkflow(ctx: InstallContext, key: string, activate: boolean): Promise<InstallResult> {
  const wf = getWorkflow(key)
  if (!wf) throw new WorkflowInstallError('Unknown workflow', 404)

  const tags = await ensureTags(ctx, wf.tags)
  const pipeline = wf.needsPipeline ? await ensureSettlementPipeline(ctx) : { pipelineId: '', stages: {} }
  const resources: WorkflowResources = { businessName: await businessName(ctx), tags, ...pipeline }
  const drafts = wf.build(resources)

  const issues = drafts.flatMap(validateDraft)
  if (issues.length > 0) throw new WorkflowInstallError('Workflow configuration is invalid', 500, issues)

  const admin = serviceDb()
  const { data: existing } = await admin
    .from('automations')
    .select('name')
    .eq('account_id', ctx.accountId)
    .in('name', drafts.map((d) => d.name))
  const taken = new Set(((existing ?? []) as { name: string }[]).map((a) => a.name))

  const result: InstallResult = { created: [], skipped: [] }
  for (const d of drafts) {
    if (taken.has(d.name)) {
      result.skipped.push(d.name)
      continue
    }
    const { data: automation, error } = await admin
      .from('automations')
      .insert({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name: d.name,
        description: d.description,
        trigger_type: d.trigger_type,
        trigger_config: d.trigger_config,
        is_active: activate,
      })
      .select('id, name')
      .single()
    if (error || !automation) throw new WorkflowInstallError(error?.message ?? 'insert failed', 500)
    const stepErr = await insertSteps((automation as { id: string }).id, d.steps)
    if (stepErr) {
      await admin.from('automations').delete().eq('id', (automation as { id: string }).id)
      throw new WorkflowInstallError(stepErr, 500)
    }
    result.created.push(automation as { id: string; name: string })
  }
  return result
}

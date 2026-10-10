import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildTrainingBlock,
  selectRelevantExamples,
  type TrainingExample,
  type TrainingProfile,
} from './training'

/**
 * Load the account's Train AI data and render the prompt block for one
 * customer question. Best-effort like `retrieveKnowledge`: a missing
 * table (migration 044 not applied) or any read error yields null and
 * never breaks a draft / auto-reply. Bumps `use_count` on the Q&A pairs
 * it picked, without waiting for the write.
 */
export async function loadTrainingBlock(
  db: SupabaseClient,
  accountId: string,
  queryText: string,
): Promise<string | null> {
  try {
    const [profileRes, examplesRes] = await Promise.all([
      db.from('ai_training_profiles').select('profile').eq('account_id', accountId).maybeSingle(),
      db
        .from('ai_training_examples')
        .select('id, kind, question, answer, category, is_active')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(500),
    ])
    if (profileRes.error && examplesRes.error) return null

    const profile = (profileRes.data?.profile ?? null) as TrainingProfile | null
    const all = ((examplesRes.data ?? []) as TrainingExample[])
    const rules = all.filter((e) => e.kind === 'rule')
    const examples = selectRelevantExamples(all, queryText)

    if (examples.length) {
      void db
        .rpc('bump_ai_training_use', { p_ids: examples.map((e) => e.id) })
        .then(({ error }) => {
          if (error) console.error('[ai training] use_count bump failed:', error.message)
        })
    }
    return buildTrainingBlock({ profile, rules, examples })
  } catch (err) {
    console.error('[ai training] load failed:', err)
    return null
  }
}

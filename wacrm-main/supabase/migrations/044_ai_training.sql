-- ============================================================
-- 044_ai_training
--
-- Backing tables for the "Train AI" page. Two kinds of training,
-- both account-scoped like the rest of the AI setup (029/030):
--
--   ai_training_profiles — one row per account: a guided business
--     profile (what you sell, tone, hours, goals …) that is turned into
--     a "Business profile" block in every AI system prompt.
--
--   ai_training_examples — the things you teach the AI one by one:
--       kind = 'qa'    a customer question and the ideal answer
--       kind = 'rule'  a do / don't instruction ("never quote delivery
--                      dates", "always ask for the order number")
--     The most relevant Q&A pairs for the current customer message, and
--     every active rule, are injected into draft / auto-reply /
--     playground prompts. `source` records where a pair came from
--     (typed in, learned from an inbox conversation, or imported from a
--     spreadsheet); `use_count` is bumped each time a pair is used.
--
-- RLS mirrors ai_knowledge (030): any member reads, agent+ writes —
-- training is day-to-day work, not an admin-only setting.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_training_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  profile     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_training_examples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'qa' CHECK (kind IN ('qa', 'rule')),
  question    text,
  answer      text NOT NULL,
  category    text,
  source      text NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual', 'conversation', 'import')),
  is_active   boolean NOT NULL DEFAULT true,
  use_count   integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'rule' OR (question IS NOT NULL AND length(trim(question)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_ai_training_examples_account
  ON ai_training_examples(account_id, kind, is_active);

ALTER TABLE ai_training_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_training_examples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_training_profiles_select ON ai_training_profiles;
CREATE POLICY ai_training_profiles_select ON ai_training_profiles FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_training_profiles_insert ON ai_training_profiles;
CREATE POLICY ai_training_profiles_insert ON ai_training_profiles FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS ai_training_profiles_update ON ai_training_profiles;
CREATE POLICY ai_training_profiles_update ON ai_training_profiles FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS ai_training_examples_select ON ai_training_examples;
CREATE POLICY ai_training_examples_select ON ai_training_examples FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_training_examples_insert ON ai_training_examples;
CREATE POLICY ai_training_examples_insert ON ai_training_examples FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS ai_training_examples_update ON ai_training_examples;
CREATE POLICY ai_training_examples_update ON ai_training_examples FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS ai_training_examples_delete ON ai_training_examples;
CREATE POLICY ai_training_examples_delete ON ai_training_examples FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON ai_training_profiles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_training_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON ai_training_examples;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_training_examples
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Bump use_count for the pairs the AI just used. SECURITY DEFINER so
-- the auto-reply path (service role) and dashboard routes share it; a
-- dashboard caller can only bump rows of an account they belong to.
CREATE OR REPLACE FUNCTION public.bump_ai_training_use(p_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE ai_training_examples
  SET use_count = use_count + 1
  WHERE id = ANY(p_ids)
    AND (auth.role() = 'service_role' OR is_account_member(account_id));
$$;
GRANT EXECUTE ON FUNCTION public.bump_ai_training_use(uuid[]) TO authenticated, service_role;

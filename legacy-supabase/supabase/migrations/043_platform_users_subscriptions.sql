-- ============================================================
-- 043_platform_users_subscriptions
--
-- Platform-level roles and subscriptions — who runs the CRM as a
-- product, and what each subscriber may use. This sits ABOVE the
-- per-account roles from 017 (owner/admin/agent/viewer): those decide
-- what someone can do inside one workspace; these decide whether the
-- person can use the CRM at all, for how long, and which left-hand tabs
-- they see.
--
--   platform_role
--     super_admin — the CRM owner. Sees and manages every user, can
--                   create users and promote/demote Admin 1 / Admin 2.
--                   Never restricted, never expires.
--     admin1      — staff admin. Manages subscription users: trials,
--                   status and tab access. Cannot touch admins.
--     admin2      — junior staff admin. Can view subscription users and
--                   start / extend their trials only.
--     subscriber  — a customer using the CRM on a trial or paid plan.
--
--   subscription_status: trial | active | expired | suspended
--     A trial lasts trial_days (1, 7 or 15) from trial_started_at; the
--     app treats a trial past trial_ends_at as expired without needing
--     a cron to flip the column.
--
--   allowed_tabs: which sidebar tabs the user may open. NULL = all.
--     Settings is always available (profile, password, WhatsApp setup).
--
-- Writes happen only through the /api/platform/* routes under the
-- service role after a role check in TypeScript, so RLS only grants a
-- user read access to their own row.
--
-- Bootstrapping
--   - Every existing user is backfilled as an `active` subscriber (no
--     trial clock), so nobody already using the CRM gets locked out.
--   - The oldest user becomes super_admin if none exists yet. To pick
--     someone else, run:
--       UPDATE platform_users SET platform_role = 'super_admin'
--       WHERE user_id = (SELECT id FROM auth.users WHERE email = '<you>');
--   - New signups get a 7-day trial with every tab enabled.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_users (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  platform_role        text NOT NULL DEFAULT 'subscriber'
                         CHECK (platform_role IN ('super_admin', 'admin1', 'admin2', 'subscriber')),
  subscription_status  text NOT NULL DEFAULT 'trial'
                         CHECK (subscription_status IN ('trial', 'active', 'expired', 'suspended')),
  trial_days           integer CHECK (trial_days IS NULL OR trial_days IN (1, 7, 15)),
  trial_started_at     timestamptz,
  trial_ends_at        timestamptz,
  allowed_tabs         text[],
  notes                text,
  updated_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_users_role ON platform_users(platform_role);

ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_users_select_own ON platform_users;
CREATE POLICY platform_users_select_own ON platform_users FOR SELECT
  USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS set_updated_at ON platform_users;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Backfill existing users as active subscribers.
-- ------------------------------------------------------------
INSERT INTO platform_users (user_id, platform_role, subscription_status)
SELECT u.id, 'subscriber', 'active'
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

-- Oldest user becomes super_admin when there is none yet.
UPDATE platform_users
SET platform_role = 'super_admin', subscription_status = 'active'
WHERE user_id = (SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM platform_users WHERE platform_role = 'super_admin');

-- ------------------------------------------------------------
-- New signups: 7-day trial, all tabs. A separate trigger (rather than
-- another edit to handle_new_user) so a failure here can never block
-- the account bootstrap — it only logs a warning, and the app lazily
-- creates the row on first load instead.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_platform_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.platform_users (
    user_id, platform_role, subscription_status,
    trial_days, trial_started_at, trial_ends_at
  )
  VALUES (
    NEW.id,
    CASE WHEN EXISTS (SELECT 1 FROM public.platform_users WHERE platform_role = 'super_admin')
         THEN 'subscriber' ELSE 'super_admin' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.platform_users WHERE platform_role = 'super_admin')
         THEN 'trial' ELSE 'active' END,
    7, now(), now() + interval '7 days'
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_platform_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_platform ON auth.users;
CREATE TRIGGER on_auth_user_created_platform
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_platform_user();

COMMENT ON TABLE platform_users IS
  'Platform role (super_admin/admin1/admin2/subscriber), subscription trial '
  'and per-user sidebar tab access. Managed via /api/platform/*.';

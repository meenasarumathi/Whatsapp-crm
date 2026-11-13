-- =============================================================================
-- User Management module — schema v2 (DOWN)
--
-- Removes everything 0001_user_module_v2.up.sql added and nothing else.
-- Existing tables (users, profiles, platform_users, password_reset_tokens) keep
-- all their original columns, constraints and rows.
--
-- SAFETY: this destroys audit and financial history. It refuses to run when any
-- history table holds rows, unless the session opts in explicitly:
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
--        -c "SET crm.allow_destructive_down = 'on'" \
--        -f db/user-module/0001_user_module_v2.down.sql
--
-- Never run it against a shared or production database.
-- The btree_gist / pgcrypto extensions are left installed (other objects may use them).
-- =============================================================================

DO $guard$
DECLARE t text; n bigint;
BEGIN
  IF current_setting('crm.allow_destructive_down', true) IS DISTINCT FROM 'on' THEN
    FOREACH t IN ARRAY ARRAY['crm_user_events', 'crm_user_ledger', 'crm_revenue_attributions',
                             'crm_access_grants', 'crm_auth_login_attempts', 'crm_auth_sessions'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
        IF n > 0 THEN
          RAISE EXCEPTION 'refusing to drop public.% (% rows of history). SET crm.allow_destructive_down = ''on'' to override.', t, n;
        END IF;
      END IF;
    END LOOP;
  END IF;
END $guard$;

-- Views
DROP VIEW IF EXISTS public.crm_user_analyst;
DROP VIEW IF EXISTS public.crm_user_balance;
DROP VIEW IF EXISTS public.crm_user_monthly_revenue;
DROP VIEW IF EXISTS public.crm_monthly_user_movement;
DROP VIEW IF EXISTS public.crm_active_access;

-- Guard trigger on the existing platform_users table
DROP TRIGGER IF EXISTS crm_platform_users_last_super_admin ON public.platform_users;

-- Tables (children first). DROP TABLE is not blocked by the row/TRUNCATE triggers.
DROP TABLE IF EXISTS public.crm_user_import_rows;
DROP TABLE IF EXISTS public.crm_user_imports;
DROP TABLE IF EXISTS public.crm_notification_deliveries;
DROP TABLE IF EXISTS public.crm_jobs;
DROP TABLE IF EXISTS public.crm_user_ledger;
DROP TABLE IF EXISTS public.crm_revenue_attributions;
DROP TABLE IF EXISTS public.crm_user_events;
DROP TABLE IF EXISTS public.crm_access_grants;
DROP TABLE IF EXISTS public.crm_auth_login_attempts;
DROP TABLE IF EXISTS public.crm_auth_sessions;
DROP TABLE IF EXISTS public.crm_mfa_recovery_codes;
DROP TABLE IF EXISTS public.crm_user_auth_security;
DROP TABLE IF EXISTS public.crm_user_profiles;

-- Columns added to the existing password_reset_tokens table
ALTER TABLE public.password_reset_tokens DROP COLUMN IF EXISTS requested_ip;
ALTER TABLE public.password_reset_tokens DROP COLUMN IF EXISTS issued_by;

-- Functions
DROP FUNCTION IF EXISTS public.crm_guard_last_super_admin();
DROP FUNCTION IF EXISTS public.crm_active_super_admin_count(uuid);
DROP FUNCTION IF EXISTS public.crm_user_ledger_check_reversal();
DROP FUNCTION IF EXISTS public.crm_rev_attr_guard();
DROP FUNCTION IF EXISTS public.crm_rev_attr_check_totals();
DROP FUNCTION IF EXISTS public.crm_access_grants_guard();
DROP FUNCTION IF EXISTS public.crm_grant_period(timestamptz, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.crm_auth_sessions_guard();
DROP FUNCTION IF EXISTS public.crm_ist_month(timestamptz);
DROP FUNCTION IF EXISTS public.crm_touch_updated_at();
DROP FUNCTION IF EXISTS public.crm_append_only();

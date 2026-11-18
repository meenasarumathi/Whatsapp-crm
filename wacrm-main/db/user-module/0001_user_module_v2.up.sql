-- =============================================================================
-- User Management module — schema v2 (UP)
--
-- Status: PHASE 0 DRAFT. Not part of db/schema.sql yet, so `npm run db:init` does
-- not apply it. Apply by hand to a LOCAL TEST database only:
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/user-module/0001_user_module_v2.up.sql
--
-- Built on top of the existing identity tables instead of duplicating them:
--   public.users                  sign-in identity, bcrypt password_hash, session_version
--   public.profiles               full_name, account, account_role
--   public.platform_users         platform_role (super_admin/admin1/admin2/subscriber)
--   public.password_reset_tokens  one-time reset links (reused, two columns added)
--
-- Rules followed:
--   * No existing table, column, constraint or enum is renamed, dropped or changed.
--     Additions to existing objects: 2 nullable columns on password_reset_tokens and
--     one guard trigger on platform_users (last Super Admin protection).
--   * Enum-like columns are text + CHECK (project convention; no new enum types).
--   * All money is BIGINT paise.
--   * Every FK that protects audit or financial history is ON DELETE RESTRICT.
--   * Audit tables (events, login attempts, ledger) are append-only by trigger,
--     including TRUNCATE.
--   * Months are computed in Asia/Kolkata.
--   * New tables have RLS enabled and no policies: only the server's owner
--     connection reads or writes them (same model as platform_users). Views use
--     security_invoker so they do not leak rows to wacrm_app.
-- Requires PostgreSQL 15+ (security_invoker views) and the btree_gist extension
-- (ships with PostgreSQL contrib, included in the pgvector/pgvector:pg16 image).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- uuid/text equality inside the grant EXCLUDE constraint

-- -----------------------------------------------------------------------------
-- Shared trigger functions
-- -----------------------------------------------------------------------------

-- Generic append-only guard. Used for UPDATE/DELETE (row) and TRUNCATE (statement).
CREATE OR REPLACE FUNCTION public.crm_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Calendar month in India, as a date (first day of that IST month).
CREATE OR REPLACE FUNCTION public.crm_ist_month(ts timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT date_trunc('month', ts, 'Asia/Kolkata')::timestamp::date $$;

-- =============================================================================
-- 1. Staff profile and lifecycle (extends public.users; no duplicate user table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.crm_user_profiles (
  user_id           uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  job_role          text CHECK (job_role IS NULL OR job_role IN (
                      'marketing', 'sales', 'it', 'content', 'video',
                      'admin_finance', 'learner_success', 'viewer')),
  department        text CHECK (department IS NULL OR length(department) <= 100),
  phone             text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,20}$'),
  lifecycle_status  text NOT NULL DEFAULT 'active'
                      CHECK (lifecycle_status IN ('active', 'suspended', 'disabled', 'left')),
  joined_at         timestamptz NOT NULL DEFAULT now(),
  left_at           timestamptz,
  created_by        uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_by        uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_user_profiles_left_at_matches_status
    CHECK ((lifecycle_status = 'left') = (left_at IS NOT NULL)),
  CONSTRAINT crm_user_profiles_left_after_join
    CHECK (left_at IS NULL OR left_at >= joined_at)
);
COMMENT ON TABLE public.crm_user_profiles IS
  'User Management: job role, department and lifecycle (active/suspended/disabled/left) per sign-in user. Permissions still come from platform_users.platform_role plus crm_access_grants.';

DROP TRIGGER IF EXISTS crm_user_profiles_touch ON public.crm_user_profiles;
CREATE TRIGGER crm_user_profiles_touch BEFORE UPDATE ON public.crm_user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

-- =============================================================================
-- 2. Authentication: security state, MFA recovery codes, sessions, login attempts
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.crm_user_auth_security (
  user_id                   uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  mfa_enabled               boolean NOT NULL DEFAULT false,
  mfa_secret_enc            text,          -- TOTP secret, AES-256-GCM via ENCRYPTION_KEY (app layer)
  mfa_enrolled_at           timestamptz,
  failed_login_count        integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until              timestamptz,
  must_change_password      boolean NOT NULL DEFAULT false,
  temp_password_expires_at  timestamptz,   -- set when an admin issues a temporary password
  password_changed_at       timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_user_auth_security_mfa_secret
    CHECK (NOT mfa_enabled OR (mfa_secret_enc IS NOT NULL AND mfa_enrolled_at IS NOT NULL)),
  CONSTRAINT crm_user_auth_security_temp_pw
    CHECK (temp_password_expires_at IS NULL OR must_change_password)
);
COMMENT ON TABLE public.crm_user_auth_security IS
  'Per-user MFA, lockout and temporary-password state. Credentials only, not history (history lives in crm_user_events / crm_auth_login_attempts).';

DROP TRIGGER IF EXISTS crm_user_auth_security_touch ON public.crm_user_auth_security;
CREATE TRIGGER crm_user_auth_security_touch BEFORE UPDATE ON public.crm_user_auth_security
  FOR EACH ROW EXECUTE FUNCTION public.crm_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.crm_mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  batch_id    uuid NOT NULL,            -- regenerating codes creates a new batch; old batch is invalidated
  code_hash   text NOT NULL UNIQUE,     -- SHA-256 of the code, never the code itself
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_crm_mfa_recovery_codes_user
  ON public.crm_mfa_recovery_codes (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Existing table, additive only: who issued an admin-initiated reset, and from where it was requested.
ALTER TABLE public.password_reset_tokens ADD COLUMN IF NOT EXISTS issued_by uuid
  REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.password_reset_tokens ADD COLUMN IF NOT EXISTS requested_ip inet;

-- One row per signed-in browser/device. The session JWT will carry this id (sid) from Phase 1.
CREATE TABLE IF NOT EXISTS public.crm_auth_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  mfa_verified_at  timestamptz,
  ip_address       inet,
  user_agent       text CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  ended_at         timestamptz,
  end_reason       text CHECK (end_reason IS NULL OR end_reason IN (
                     'logout', 'timeout', 'revoked', 'revoked_all',
                     'password_changed', 'user_suspended', 'user_disabled', 'user_left')),
  revoked_by       uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT crm_auth_sessions_end_pair CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CONSTRAINT crm_auth_sessions_expiry   CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_crm_auth_sessions_user_active
  ON public.crm_auth_sessions (user_id, last_seen_at DESC) WHERE ended_at IS NULL;
COMMENT ON TABLE public.crm_auth_sessions IS
  'Sessions (separate from login attempts). Ending a session sets ended_at/end_reason; rows are never deleted.';

-- Only the end fields and last_seen_at may change, and an ended session stays ended.
CREATE OR REPLACE FUNCTION public.crm_auth_sessions_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crm_auth_sessions rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at
     OR NEW.ip_address IS DISTINCT FROM OLD.ip_address OR NEW.user_agent IS DISTINCT FROM OLD.user_agent THEN
    RAISE EXCEPTION 'crm_auth_sessions: identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at
     OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'crm_auth_sessions: an ended session cannot be reopened or re-ended'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_auth_sessions_guard ON public.crm_auth_sessions;
CREATE TRIGGER crm_auth_sessions_guard BEFORE UPDATE OR DELETE ON public.crm_auth_sessions
  FOR EACH ROW EXECUTE FUNCTION public.crm_auth_sessions_guard();

-- Every sign-in attempt, successful or not (separate from sessions). Append-only.
CREATE TABLE IF NOT EXISTS public.crm_auth_login_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES public.users(id) ON DELETE RESTRICT,  -- NULL when no user matched
  attempted_email  text NOT NULL CHECK (length(attempted_email) <= 320),
  outcome          text NOT NULL CHECK (outcome IN (
                     'success', 'bad_password', 'unknown_user', 'locked', 'suspended',
                     'disabled', 'left', 'mfa_required', 'mfa_failed', 'mfa_recovery_code_used',
                     'temp_password_expired', 'rate_limited')),
  session_id       uuid REFERENCES public.crm_auth_sessions(id) ON DELETE RESTRICT,
  ip_address       inet,
  user_agent       text CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_auth_login_attempts_session_on_success
    CHECK ((outcome IN ('success', 'mfa_recovery_code_used')) = (session_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_auth_login_attempts_user
  ON public.crm_auth_login_attempts (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_auth_login_attempts_email
  ON public.crm_auth_login_attempts (lower(attempted_email), occurred_at DESC);

DROP TRIGGER IF EXISTS crm_auth_login_attempts_append_only ON public.crm_auth_login_attempts;
CREATE TRIGGER crm_auth_login_attempts_append_only BEFORE UPDATE OR DELETE ON public.crm_auth_login_attempts
  FOR EACH ROW EXECUTE FUNCTION public.crm_append_only();
DROP TRIGGER IF EXISTS crm_auth_login_attempts_no_truncate ON public.crm_auth_login_attempts;
CREATE TRIGGER crm_auth_login_attempts_no_truncate BEFORE TRUNCATE ON public.crm_auth_login_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.crm_append_only();

-- =============================================================================
-- 3. Access grants (what, when, how long, why) — no overlaps per user + module
-- =============================================================================

-- Effective period of a grant: [starts_at, earliest of expires_at / revoked_at).
-- Open-ended (both NULL) → unbounded. Revoked before it started → empty range.
CREATE OR REPLACE FUNCTION public.crm_grant_period(starts timestamptz, expires timestamptz, revoked timestamptz)
RETURNS tstzrange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN expires IS NULL AND revoked IS NULL THEN tstzrange(starts, NULL, '[)')
    ELSE tstzrange(starts, GREATEST(starts, LEAST(expires, revoked)), '[)')
  END
$$;

CREATE TABLE IF NOT EXISTS public.crm_access_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  module         text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{1,39}$'),
  level          text NOT NULL CHECK (level IN ('read', 'write', 'manage')),
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  granted_by     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  starts_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,                 -- NULL = open-ended, listed for review
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  revoke_reason  text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 1000),
  replaces_grant_id uuid REFERENCES public.crm_access_grants(id) ON DELETE RESTRICT,  -- level change / renewal chain
  CONSTRAINT crm_access_grants_expiry CHECK (expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT crm_access_grants_revoke_pair
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT crm_access_grants_no_overlap EXCLUDE USING gist (
    user_id WITH =,
    module  WITH =,
    public.crm_grant_period(starts_at, expires_at, revoked_at) WITH &&
  )
);
CREATE INDEX IF NOT EXISTS idx_crm_access_grants_user_live
  ON public.crm_access_grants (user_id, module) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_access_grants_expiring
  ON public.crm_access_grants (expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
COMMENT ON TABLE public.crm_access_grants IS
  'Module access per user. At most one effective grant per (user, module) at any instant (EXCLUDE). Grants are never deleted; only revoke fields may be set, once.';

-- A grant is immutable except for being revoked once (revoked_at/by/reason).
CREATE OR REPLACE FUNCTION public.crm_access_grants_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crm_access_grants rows are never deleted (revoke instead)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'crm_access_grants: grant % is already revoked', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.module, NEW.level, NEW.reason, NEW.granted_by, NEW.granted_at, NEW.starts_at)
       IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.module, OLD.level, OLD.reason, OLD.granted_by, OLD.granted_at, OLD.starts_at)
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.replaces_grant_id IS DISTINCT FROM OLD.replaces_grant_id THEN
    RAISE EXCEPTION 'crm_access_grants: only revoked_at, revoked_by and revoke_reason may change (issue a new grant to extend or change level)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_access_grants_guard ON public.crm_access_grants;
CREATE TRIGGER crm_access_grants_guard BEFORE UPDATE OR DELETE ON public.crm_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.crm_access_grants_guard();

-- =============================================================================
-- 4. User events — append-only audit trail
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.crm_user_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id  uuid REFERENCES public.users(id) ON DELETE RESTRICT,  -- NULL for org-wide events (exports, reports)
  actor_id         uuid REFERENCES public.users(id) ON DELETE RESTRICT,  -- NULL = system / background job
  event_type       text NOT NULL CHECK (event_type IN (
    -- lifecycle
    'joined', 'profile_edited', 'platform_role_changed', 'job_role_changed',
    'suspended', 'reinstated', 'disabled', 'left', 'rejoined',
    -- access
    'access_granted', 'access_revoked', 'access_expired', 'access_expiry_reminder_sent',
    -- authentication, MFA, password, sessions
    'mfa_enrolled', 'mfa_disabled', 'mfa_reset_by_admin', 'mfa_recovery_codes_regenerated',
    'mfa_recovery_code_used', 'password_changed', 'password_reset_requested',
    'password_reset_completed', 'temp_password_issued', 'account_locked', 'account_unlocked',
    'session_revoked', 'all_sessions_revoked',
    -- revenue and ledger
    'revenue_attributed', 'revenue_refund_recorded', 'revenue_cancelled',
    'ledger_commission_added', 'ledger_payout_recorded', 'ledger_adjustment_added',
    'ledger_entry_reversed',
    -- exports, analyst views, bulk import
    'export_requested', 'export_downloaded',
    'analyst_viewed', 'balance_viewed', 'monthly_report_viewed',
    'bulk_import_started', 'bulk_import_completed')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 1000),
  details          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  ref_table        text CHECK (ref_table IS NULL OR ref_table ~ '^[a-z_]{1,63}$'),
  ref_id           uuid,
  ip_address       inet,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  -- Changes that need a human justification.
  CONSTRAINT crm_user_events_reason_required CHECK (
    event_type NOT IN ('platform_role_changed', 'job_role_changed', 'suspended', 'reinstated',
                       'disabled', 'left', 'rejoined', 'access_granted', 'access_revoked',
                       'mfa_reset_by_admin', 'account_unlocked', 'all_sessions_revoked',
                       'ledger_adjustment_added', 'ledger_entry_reversed', 'revenue_cancelled')
    OR (reason IS NOT NULL AND length(btrim(reason)) >= 3)),
  CONSTRAINT crm_user_events_subject_required CHECK (
    event_type IN ('export_requested', 'export_downloaded', 'analyst_viewed',
                   'monthly_report_viewed', 'bulk_import_started', 'bulk_import_completed')
    OR subject_user_id IS NOT NULL),
  CONSTRAINT crm_user_events_ref_pair CHECK ((ref_table IS NULL) = (ref_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_user_events_subject
  ON public.crm_user_events (subject_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_user_events_type_time
  ON public.crm_user_events (event_type, occurred_at);
-- IST month expression is IMMUTABLE (3-arg date_trunc), so it can be indexed.
CREATE INDEX IF NOT EXISTS idx_crm_user_events_ist_month
  ON public.crm_user_events (public.crm_ist_month(occurred_at), event_type);

DROP TRIGGER IF EXISTS crm_user_events_append_only ON public.crm_user_events;
CREATE TRIGGER crm_user_events_append_only BEFORE UPDATE OR DELETE ON public.crm_user_events
  FOR EACH ROW EXECUTE FUNCTION public.crm_append_only();
DROP TRIGGER IF EXISTS crm_user_events_no_truncate ON public.crm_user_events;
CREATE TRIGGER crm_user_events_no_truncate BEFORE TRUNCATE ON public.crm_user_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.crm_append_only();

-- =============================================================================
-- 5. Revenue attribution (per user share of a payment), with payment state
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.crm_revenue_attributions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  payment_provider    text NOT NULL DEFAULT 'razorpay' CHECK (payment_provider IN ('razorpay', 'manual')),
  payment_ref         text NOT NULL CHECK (length(payment_ref) BETWEEN 1 AND 100),  -- e.g. Razorpay pay_XXXX
  currency            text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  gross_amount_paise  bigint NOT NULL CHECK (gross_amount_paise > 0),               -- whole payment
  attribution_role    text NOT NULL CHECK (attribution_role IN ('lead_owner', 'closer', 'manual')),
  share_bp            integer NOT NULL CHECK (share_bp BETWEEN 1 AND 10000),       -- basis points, 10000 = 100%
  attributed_paise    bigint NOT NULL CHECK (attributed_paise >= 0),               -- this user's share, rounded by the app
  payment_status      text NOT NULL DEFAULT 'captured' CHECK (payment_status IN (
                        'captured', 'partially_refunded', 'refunded', 'cancelled')),
  refunded_paise      bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),       -- this user's share of refunds
  paid_at             timestamptz NOT NULL,
  refunded_at         timestamptz,       -- time of the latest refund
  cancelled_at        timestamptz,
  cancel_reason       text,
  created_by          uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_rev_attr_unique UNIQUE (payment_provider, payment_ref, user_id, attribution_role),
  CONSTRAINT crm_rev_attr_share_le_gross CHECK (attributed_paise <= gross_amount_paise),
  CONSTRAINT crm_rev_attr_refund_le_share CHECK (refunded_paise <= attributed_paise),
  CONSTRAINT crm_rev_attr_status_consistency CHECK (
    (payment_status = 'captured'           AND refunded_paise = 0 AND cancelled_at IS NULL) OR
    (payment_status = 'partially_refunded' AND refunded_paise > 0 AND refunded_paise < attributed_paise
                                           AND refunded_at IS NOT NULL AND cancelled_at IS NULL) OR
    (payment_status = 'refunded'           AND refunded_paise = attributed_paise
                                           AND refunded_at IS NOT NULL AND cancelled_at IS NULL) OR
    (payment_status = 'cancelled'          AND cancelled_at IS NOT NULL
                                           AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) >= 3))
);
CREATE INDEX IF NOT EXISTS idx_crm_rev_attr_user_paid ON public.crm_revenue_attributions (user_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_crm_rev_attr_payment ON public.crm_revenue_attributions (payment_provider, payment_ref);
COMMENT ON TABLE public.crm_revenue_attributions IS
  'Each user''s share of a payment. Net revenue = attributed_paise - refunded_paise, and 0 when cancelled. Rows are never deleted; only payment-state columns change.';

-- Shares of one payment may not exceed 100% or the gross amount.
CREATE OR REPLACE FUNCTION public.crm_rev_attr_check_totals()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tot_bp bigint; tot_paise bigint; gross_mismatch boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('crm_rev_attr:' || NEW.payment_provider || ':' || NEW.payment_ref));
  SELECT sum(share_bp), sum(attributed_paise),
         count(DISTINCT gross_amount_paise) > 1
    INTO tot_bp, tot_paise, gross_mismatch
    FROM public.crm_revenue_attributions
   WHERE payment_provider = NEW.payment_provider AND payment_ref = NEW.payment_ref;
  IF gross_mismatch THEN
    RAISE EXCEPTION 'payment %: all attribution rows must carry the same gross_amount_paise', NEW.payment_ref
      USING ERRCODE = 'check_violation';
  END IF;
  IF tot_bp > 10000 THEN
    RAISE EXCEPTION 'payment %: attribution shares add up to % bp (max 10000)', NEW.payment_ref, tot_bp
      USING ERRCODE = 'check_violation';
  END IF;
  IF tot_paise > NEW.gross_amount_paise THEN
    RAISE EXCEPTION 'payment %: attributed paise % exceed gross %', NEW.payment_ref, tot_paise, NEW.gross_amount_paise
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS crm_rev_attr_totals ON public.crm_revenue_attributions;
CREATE CONSTRAINT TRIGGER crm_rev_attr_totals AFTER INSERT ON public.crm_revenue_attributions
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.crm_rev_attr_check_totals();

-- Only payment-state columns may change; refunds only grow; cancelled is final.
CREATE OR REPLACE FUNCTION public.crm_rev_attr_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crm_revenue_attributions rows are never deleted (cancel instead)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.payment_provider, NEW.payment_ref, NEW.currency, NEW.gross_amount_paise,
      NEW.attribution_role, NEW.share_bp, NEW.attributed_paise, NEW.paid_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.payment_provider, OLD.payment_ref, OLD.currency, OLD.gross_amount_paise,
      OLD.attribution_role, OLD.share_bp, OLD.attributed_paise, OLD.paid_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'crm_revenue_attributions: only payment_status, refund and cancel fields may change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.refunded_paise < OLD.refunded_paise THEN
    RAISE EXCEPTION 'crm_revenue_attributions: refunded_paise cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.payment_status = 'cancelled' THEN
    RAISE EXCEPTION 'crm_revenue_attributions: a cancelled attribution is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_rev_attr_guard ON public.crm_revenue_attributions;
CREATE TRIGGER crm_rev_attr_guard BEFORE UPDATE OR DELETE ON public.crm_revenue_attributions
  FOR EACH ROW EXECUTE FUNCTION public.crm_rev_attr_guard();
DROP TRIGGER IF EXISTS crm_rev_attr_no_truncate ON public.crm_revenue_attributions;
CREATE TRIGGER crm_rev_attr_no_truncate BEFORE TRUNCATE ON public.crm_revenue_attributions
  FOR EACH STATEMENT EXECUTE FUNCTION public.crm_append_only();

-- =============================================================================
-- 6. Balance ledger — append-only; mistakes are fixed with a linked reversal
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.crm_user_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  entry_type      text NOT NULL CHECK (entry_type IN ('commission', 'payout', 'adjustment', 'reversal')),
  amount_paise    bigint NOT NULL CHECK (amount_paise <> 0),   -- credit > 0, debit < 0
  reversal_of     uuid UNIQUE REFERENCES public.crm_user_ledger(id) ON DELETE RESTRICT,
  attribution_id  uuid REFERENCES public.crm_revenue_attributions(id) ON DELETE RESTRICT,
  reference       text CHECK (reference IS NULL OR length(reference) <= 200),  -- payout UTR, etc.
  reason          text CHECK (reason IS NULL OR length(reason) <= 1000),
  created_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_user_ledger_sign CHECK (
    (entry_type = 'commission' AND amount_paise > 0) OR
    (entry_type = 'payout'     AND amount_paise < 0) OR
    (entry_type IN ('adjustment', 'reversal'))),
  CONSTRAINT crm_user_ledger_reversal_link CHECK ((entry_type = 'reversal') = (reversal_of IS NOT NULL)),
  CONSTRAINT crm_user_ledger_reason_required CHECK (
    entry_type NOT IN ('adjustment', 'reversal') OR (reason IS NOT NULL AND length(btrim(reason)) >= 3))
);
CREATE INDEX IF NOT EXISTS idx_crm_user_ledger_user_time ON public.crm_user_ledger (user_id, created_at);
COMMENT ON TABLE public.crm_user_ledger IS
  'Per-user money ledger (paise). Balance = SUM(amount_paise). Append-only; a wrong entry is cancelled by one reversal row (reversal_of) with the exact opposite amount.';

-- A reversal must mirror its original exactly and cannot itself be reversed.
CREATE OR REPLACE FUNCTION public.crm_user_ledger_check_reversal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE orig public.crm_user_ledger%ROWTYPE;
BEGIN
  -- No link: let crm_user_ledger_reversal_link (CHECK) reject it with the right error.
  IF NEW.entry_type <> 'reversal' OR NEW.reversal_of IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO orig FROM public.crm_user_ledger WHERE id = NEW.reversal_of FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'crm_user_ledger: reversal_of % not found', NEW.reversal_of USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF orig.entry_type = 'reversal' THEN
    RAISE EXCEPTION 'crm_user_ledger: a reversal cannot be reversed (post a new entry instead)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF orig.user_id <> NEW.user_id OR NEW.amount_paise <> -orig.amount_paise THEN
    RAISE EXCEPTION 'crm_user_ledger: reversal must be for the same user and exactly % paise', -orig.amount_paise
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_user_ledger_reversal ON public.crm_user_ledger;
CREATE TRIGGER crm_user_ledger_reversal BEFORE INSERT ON public.crm_user_ledger
  FOR EACH ROW EXECUTE FUNCTION public.crm_user_ledger_check_reversal();

DROP TRIGGER IF EXISTS crm_user_ledger_append_only ON public.crm_user_ledger;
CREATE TRIGGER crm_user_ledger_append_only BEFORE UPDATE OR DELETE ON public.crm_user_ledger
  FOR EACH ROW EXECUTE FUNCTION public.crm_append_only();
DROP TRIGGER IF EXISTS crm_user_ledger_no_truncate ON public.crm_user_ledger;
CREATE TRIGGER crm_user_ledger_no_truncate BEFORE TRUNCATE ON public.crm_user_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.crm_append_only();

-- =============================================================================
-- 7. Background jobs, notification delivery, bulk import
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.crm_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN (
                  'expire_grants', 'send_expiry_reminders', 'export_users', 'export_events',
                  'export_revenue', 'export_ledger', 'bulk_import_users', 'expire_temp_passwords')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  dedupe_key    text,                      -- e.g. 'expire_grants:2026-11-13T10:00'
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  result        jsonb,
  created_by    uuid REFERENCES public.users(id) ON DELETE RESTRICT,   -- NULL = scheduler
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT crm_jobs_finished CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_jobs_dedupe ON public.crm_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_jobs_ready ON public.crm_jobs (run_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS public.crm_notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN (
                    'grant_expiry_reminder', 'grant_expired', 'temp_password_issued',
                    'password_reset', 'mfa_changed', 'export_ready')),
  channel         text NOT NULL CHECK (channel IN ('email', 'in_app')),
  grant_id        uuid REFERENCES public.crm_access_grants(id) ON DELETE RESTRICT,
  job_id          uuid REFERENCES public.crm_jobs(id) ON DELETE RESTRICT,
  dedupe_key      text NOT NULL UNIQUE,    -- e.g. 'grant_expiry_reminder:<grant>:7d:email'
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_notif_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_crm_notif_pending ON public.crm_notification_deliveries (scheduled_for) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.crm_user_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  file_name     text NOT NULL CHECK (length(file_name) <= 255),
  status        text NOT NULL DEFAULT 'validating'
                  CHECK (status IN ('validating', 'ready', 'importing', 'completed', 'failed', 'cancelled')),
  dry_run       boolean NOT NULL DEFAULT true,
  total_rows    integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  ok_rows       integer NOT NULL DEFAULT 0 CHECK (ok_rows >= 0),
  failed_rows   integer NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  job_id        uuid REFERENCES public.crm_jobs(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT crm_user_imports_counts CHECK (ok_rows + failed_rows <= total_rows)
);

CREATE TABLE IF NOT EXISTS public.crm_user_import_rows (
  import_id        uuid NOT NULL REFERENCES public.crm_user_imports(id) ON DELETE RESTRICT,
  row_number       integer NOT NULL CHECK (row_number >= 1),
  raw              jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'valid', 'invalid', 'created', 'skipped_duplicate', 'failed')),
  error            text,
  created_user_id  uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  PRIMARY KEY (import_id, row_number)
);

-- =============================================================================
-- 8. Last Super Admin protection (guard on the existing platform_users table)
-- =============================================================================
-- There must always be at least one platform super_admin who is not suspended
-- and whose lifecycle status is active. Serialised with an advisory lock so two
-- concurrent demotions cannot both pass.
CREATE OR REPLACE FUNCTION public.crm_active_super_admin_count(excluding uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*)
    FROM public.platform_users p
    LEFT JOIN public.crm_user_profiles c ON c.user_id = p.user_id
   WHERE p.platform_role = 'super_admin'
     AND p.subscription_status <> 'suspended'
     AND COALESCE(c.lifecycle_status, 'active') = 'active'
     AND p.user_id <> excluding
$$;

CREATE OR REPLACE FUNCTION public.crm_guard_last_super_admin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE was_active boolean; still_active boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('crm_last_super_admin'));
  IF TG_TABLE_NAME = 'platform_users' THEN
    was_active := OLD.platform_role = 'super_admin' AND OLD.subscription_status <> 'suspended'
                  AND COALESCE((SELECT lifecycle_status FROM public.crm_user_profiles WHERE user_id = OLD.user_id), 'active') = 'active';
    still_active := TG_OP = 'UPDATE' AND NEW.platform_role = 'super_admin' AND NEW.subscription_status <> 'suspended'
                  AND NEW.user_id = OLD.user_id AND was_active;
  ELSE  -- crm_user_profiles
    was_active := OLD.lifecycle_status = 'active'
                  AND EXISTS (SELECT 1 FROM public.platform_users WHERE user_id = OLD.user_id
                               AND platform_role = 'super_admin' AND subscription_status <> 'suspended');
    still_active := TG_OP = 'UPDATE' AND NEW.lifecycle_status = 'active';
  END IF;
  IF was_active AND NOT still_active AND public.crm_active_super_admin_count(OLD.user_id) = 0 THEN
    RAISE EXCEPTION 'cannot remove, demote, suspend or deactivate the last active Super Admin'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS crm_platform_users_last_super_admin ON public.platform_users;
CREATE TRIGGER crm_platform_users_last_super_admin BEFORE UPDATE OR DELETE ON public.platform_users
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_last_super_admin();
DROP TRIGGER IF EXISTS crm_user_profiles_last_super_admin ON public.crm_user_profiles;
CREATE TRIGGER crm_user_profiles_last_super_admin BEFORE UPDATE OR DELETE ON public.crm_user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.crm_guard_last_super_admin();

-- =============================================================================
-- 9. Report views (months in Asia/Kolkata). security_invoker: RLS of the base
--    tables applies to whoever queries, so wacrm_app sees nothing.
-- =============================================================================
CREATE OR REPLACE VIEW public.crm_active_access WITH (security_invoker = true) AS
SELECT g.id, g.user_id, p.full_name, u.email, g.module, g.level, g.reason,
       g.granted_by, g.granted_at, g.starts_at, g.expires_at,
       (g.expires_at IS NULL) AS needs_review
  FROM public.crm_access_grants g
  JOIN public.users u ON u.id = g.user_id
  LEFT JOIN public.profiles p ON p.user_id = g.user_id
 WHERE g.revoked_at IS NULL
   AND g.starts_at <= now()
   AND (g.expires_at IS NULL OR g.expires_at > now());

-- Counting rules (see docs/user-module-assumptions.md, decision 5):
--   * joined counts 'joined' events; 'rejoined' and 'reinstated' are separate columns.
--   * a user who joins and leaves in the same month is counted in both joined and left.
--   * *_events counts every event; *_users counts distinct users (repeated grants count once).
CREATE OR REPLACE VIEW public.crm_monthly_user_movement WITH (security_invoker = true) AS
SELECT public.crm_ist_month(e.occurred_at)                                        AS month_ist,
       count(*)                       FILTER (WHERE e.event_type = 'joined')       AS joined,
       count(*)                       FILTER (WHERE e.event_type = 'rejoined')     AS rejoined,
       count(*)                       FILTER (WHERE e.event_type = 'left')         AS left_count,
       count(*)                       FILTER (WHERE e.event_type = 'suspended')    AS suspended,
       count(*)                       FILTER (WHERE e.event_type = 'reinstated')   AS reinstated,
       count(*)                       FILTER (WHERE e.event_type = 'disabled')     AS disabled,
       count(*)                       FILTER (WHERE e.event_type = 'access_granted') AS access_grant_events,
       count(DISTINCT e.subject_user_id) FILTER (WHERE e.event_type = 'access_granted') AS access_granted_users,
       count(*)                       FILTER (WHERE e.event_type IN ('access_revoked', 'access_expired')) AS access_end_events,
       count(DISTINCT e.subject_user_id) FILTER (WHERE e.event_type IN ('access_revoked', 'access_expired')) AS access_ended_users
  FROM public.crm_user_events e
 GROUP BY 1;

-- Net revenue per user per IST month of the payment. Refunds reduce the month the
-- payment was made in (restated); cancelled attributions count as zero.
CREATE OR REPLACE VIEW public.crm_user_monthly_revenue WITH (security_invoker = true) AS
SELECT a.user_id,
       public.crm_ist_month(a.paid_at)                                              AS month_ist,
       count(*) FILTER (WHERE a.payment_status <> 'cancelled')                      AS payments,
       COALESCE(sum(a.attributed_paise) FILTER (WHERE a.payment_status <> 'cancelled'), 0)::bigint AS gross_share_paise,
       COALESCE(sum(a.refunded_paise)   FILTER (WHERE a.payment_status <> 'cancelled'), 0)::bigint AS refunded_paise,
       COALESCE(sum(a.attributed_paise - a.refunded_paise)
                FILTER (WHERE a.payment_status <> 'cancelled'), 0)::bigint          AS net_revenue_paise
  FROM public.crm_revenue_attributions a
 GROUP BY 1, 2;

-- Balances: Super Admin only (enforced in the API; never joined into the admin analyst view).
CREATE OR REPLACE VIEW public.crm_user_balance WITH (security_invoker = true) AS
SELECT u.id AS user_id,
       COALESCE(sum(l.amount_paise), 0)::bigint AS balance_paise,
       max(l.created_at)                         AS last_ledger_at
  FROM public.users u
  LEFT JOIN public.crm_user_ledger l ON l.user_id = u.id
 GROUP BY u.id;

-- Analyst tab (admins): access + revenue, no balance.
CREATE OR REPLACE VIEW public.crm_user_analyst WITH (security_invoker = true) AS
SELECT u.id AS user_id, p.full_name, u.email, pu.platform_role, c.job_role,
       COALESCE(c.lifecycle_status, 'active')   AS lifecycle_status,
       u.last_sign_in_at,
       (SELECT count(*) FROM public.crm_active_access a WHERE a.user_id = u.id) AS active_grants,
       COALESCE((SELECT r.net_revenue_paise FROM public.crm_user_monthly_revenue r
                  WHERE r.user_id = u.id AND r.month_ist = public.crm_ist_month(now())), 0)::bigint
                                                AS net_revenue_this_month_paise,
       COALESCE((SELECT sum(r.net_revenue_paise) FROM public.crm_user_monthly_revenue r
                  WHERE r.user_id = u.id), 0)::bigint AS net_revenue_lifetime_paise
  FROM public.users u
  LEFT JOIN public.profiles p        ON p.user_id = u.id
  LEFT JOIN public.platform_users pu ON pu.user_id = u.id
  LEFT JOIN public.crm_user_profiles c ON c.user_id = u.id;

-- =============================================================================
-- 10. Row Level Security: on, no policies → server owner connection only
-- =============================================================================
ALTER TABLE public.crm_user_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_auth_security      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_mfa_recovery_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_auth_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_auth_login_attempts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_access_grants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_revenue_attributions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_ledger             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_jobs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_imports            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_import_rows        ENABLE ROW LEVEL SECURITY;

-- Section 9 grants every table to wacrm_app on re-runs. These tables are read and
-- written only by the server's owner connection (MFA secrets, sessions, audit,
-- money), so the application role gets no table privileges at all (RLS is the
-- second line of defence).
REVOKE ALL ON public.crm_user_profiles, public.crm_user_auth_security, public.crm_mfa_recovery_codes,
              public.crm_auth_sessions, public.crm_auth_login_attempts, public.crm_access_grants,
              public.crm_user_events, public.crm_revenue_attributions, public.crm_user_ledger,
              public.crm_jobs, public.crm_notification_deliveries, public.crm_user_imports,
              public.crm_user_import_rows,
              public.crm_active_access, public.crm_monthly_user_movement, public.crm_user_monthly_revenue,
              public.crm_user_balance, public.crm_user_analyst
  FROM wacrm_app;

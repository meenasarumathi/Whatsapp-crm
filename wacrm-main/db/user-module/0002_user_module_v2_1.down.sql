-- =============================================================================
-- User Management module — schema v2.1 (DOWN). Undoes 0002 only; 0001 stays.
-- Refuses when payments, splits or ledger rows exist unless
--   SET crm.allow_destructive_down = 'on'
-- LOCAL TEST DATABASES ONLY.
-- =============================================================================

DO $guard$
DECLARE t text; n bigint;
BEGIN
  IF current_setting('crm.allow_destructive_down', true) IS DISTINCT FROM 'on' THEN
    FOREACH t IN ARRAY ARRAY['crm_revenue_payments', 'crm_revenue_splits', 'crm_user_ledger'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
        IF n > 0 THEN
          RAISE EXCEPTION 'refusing to undo v2.1: public.% has % rows. SET crm.allow_destructive_down = ''on'' to override.', t, n;
        END IF;
      END IF;
    END LOOP;
  END IF;
END $guard$;

-- Revenue view back to the 0001 definition (attributions).
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
COMMENT ON TABLE public.crm_revenue_attributions IS
  'Each user''s share of a payment. Net revenue = attributed_paise - refunded_paise, and 0 when cancelled. Rows are never deleted; only payment-state columns change.';

ALTER TABLE public.crm_user_ledger DROP COLUMN IF EXISTS split_id;
DROP TABLE IF EXISTS public.crm_revenue_splits;
DROP TABLE IF EXISTS public.crm_revenue_payments;
DROP FUNCTION IF EXISTS public.crm_revenue_splits_guard();
DROP FUNCTION IF EXISTS public.crm_revenue_payments_guard();
DROP FUNCTION IF EXISTS public.crm_revenue_check_split_totals();

DROP TRIGGER IF EXISTS crm_user_ledger_balance ON public.crm_user_ledger;
DROP FUNCTION IF EXISTS public.crm_user_ledger_check_balance();
ALTER TABLE public.crm_user_ledger DROP CONSTRAINT IF EXISTS crm_user_ledger_overdraw_needs_reason;
ALTER TABLE public.crm_user_ledger DROP CONSTRAINT IF EXISTS crm_user_ledger_idempotency_key_format;
ALTER TABLE public.crm_user_ledger DROP CONSTRAINT IF EXISTS crm_user_ledger_idempotency_key_key;
ALTER TABLE public.crm_user_ledger DROP COLUMN IF EXISTS allow_overdraw;
ALTER TABLE public.crm_user_ledger DROP COLUMN IF EXISTS idempotency_key;

DROP INDEX IF EXISTS public.idx_crm_access_grants_review_due;
ALTER TABLE public.crm_access_grants DROP CONSTRAINT IF EXISTS crm_access_grants_review_after_start;
ALTER TABLE public.crm_access_grants DROP CONSTRAINT IF EXISTS crm_access_grants_open_needs_review;
ALTER TABLE public.crm_access_grants DROP COLUMN IF EXISTS review_due_at;

-- Grant guard back to the 0001 body.
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

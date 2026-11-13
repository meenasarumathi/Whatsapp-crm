-- =============================================================================
-- User Management module — schema v2.1 (UP). Additive on top of 0001.
-- Approved by the owner on 13 Nov 2026 (acceptance test rules A–D).
--
--   A. An open-ended grant (no expires_at) must carry a review date.
--   B. A payout may not take a user's balance below zero unless explicitly
--      overridden (allow_overdraw + reason).
--   C. Every ledger entry has a unique idempotency_key (no double posting).
--   D. Payments live in their own table (manual entry / CSV import) and are
--      split between users; when a payment has splits they must total exactly
--      100% and exactly the payment amount. A payment reference is unique.
--
-- Nothing in 0001 is renamed or dropped. crm_revenue_attributions stays in
-- place but is superseded by payments + splits (the revenue view now reads
-- splits). Requires 0001. LOCAL TEST DATABASE ONLY until folded into schema.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Review date for open-ended access
-- -----------------------------------------------------------------------------
ALTER TABLE public.crm_access_grants ADD COLUMN IF NOT EXISTS review_due_at timestamptz;

DO $con$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_access_grants_open_needs_review'
                  AND conrelid = 'public.crm_access_grants'::regclass) THEN
    ALTER TABLE public.crm_access_grants ADD CONSTRAINT crm_access_grants_open_needs_review
      CHECK (expires_at IS NOT NULL OR review_due_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_access_grants_review_after_start'
                  AND conrelid = 'public.crm_access_grants'::regclass) THEN
    ALTER TABLE public.crm_access_grants ADD CONSTRAINT crm_access_grants_review_after_start
      CHECK (review_due_at IS NULL OR review_due_at > starts_at);
  END IF;
END $con$;

CREATE INDEX IF NOT EXISTS idx_crm_access_grants_review_due
  ON public.crm_access_grants (review_due_at) WHERE revoked_at IS NULL AND review_due_at IS NOT NULL;

-- Same guard as 0001, plus: review_due_at may be moved (a completed review sets the next date).
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
    RAISE EXCEPTION 'crm_access_grants: only the revoke fields and review_due_at may change (issue a new grant to extend or change level)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- B + C. Ledger: no overdraw without override; idempotency key
-- -----------------------------------------------------------------------------
ALTER TABLE public.crm_user_ledger ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.crm_user_ledger ADD COLUMN IF NOT EXISTS allow_overdraw boolean NOT NULL DEFAULT false;
ALTER TABLE public.crm_user_ledger ALTER COLUMN idempotency_key SET NOT NULL;

DO $con$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_user_ledger_idempotency_key_key'
                  AND conrelid = 'public.crm_user_ledger'::regclass) THEN
    ALTER TABLE public.crm_user_ledger ADD CONSTRAINT crm_user_ledger_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_user_ledger_idempotency_key_format'
                  AND conrelid = 'public.crm_user_ledger'::regclass) THEN
    ALTER TABLE public.crm_user_ledger ADD CONSTRAINT crm_user_ledger_idempotency_key_format
      CHECK (length(idempotency_key) BETWEEN 1 AND 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_user_ledger_overdraw_needs_reason'
                  AND conrelid = 'public.crm_user_ledger'::regclass) THEN
    ALTER TABLE public.crm_user_ledger ADD CONSTRAINT crm_user_ledger_overdraw_needs_reason
      CHECK (NOT allow_overdraw OR (entry_type = 'payout' AND reason IS NOT NULL AND length(btrim(reason)) >= 3));
  END IF;
END $con$;

-- A payout may not take the balance below zero unless allow_overdraw is set.
-- Serialised per user so two concurrent payouts cannot both pass.
CREATE OR REPLACE FUNCTION public.crm_user_ledger_check_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal bigint;
BEGIN
  IF NEW.entry_type <> 'payout' OR NEW.allow_overdraw THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crm_user_ledger:' || NEW.user_id::text));
  SELECT COALESCE(sum(amount_paise), 0) INTO bal FROM public.crm_user_ledger WHERE user_id = NEW.user_id;
  IF bal + NEW.amount_paise < 0 THEN
    RAISE EXCEPTION 'payout of % paise would take the balance (% paise) below zero; set allow_overdraw with a reason to override',
      -NEW.amount_paise, bal USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_user_ledger_balance ON public.crm_user_ledger;
CREATE TRIGGER crm_user_ledger_balance BEFORE INSERT ON public.crm_user_ledger
  FOR EACH ROW EXECUTE FUNCTION public.crm_user_ledger_check_balance();

-- -----------------------------------------------------------------------------
-- D. Payments and splits
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_revenue_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref     text NOT NULL CHECK (length(btrim(external_ref)) BETWEEN 1 AND 100),  -- e.g. Razorpay pay_XXXX, receipt no.
  source           text NOT NULL CHECK (source IN ('manual', 'csv_import')),
  payment_date     timestamptz NOT NULL,
  amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
  currency         text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  customer_name    text CHECK (customer_name IS NULL OR length(customer_name) <= 200),
  description      text CHECK (description IS NULL OR length(description) <= 500),
  status           text NOT NULL DEFAULT 'captured' CHECK (status IN (
                     'captured', 'partially_refunded', 'refunded', 'cancelled')),
  refunded_paise   bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  refunded_at      timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  import_id        uuid,                      -- the CSV import that created it (Phase 4/6)
  recorded_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_revenue_payments_refund_le_amount CHECK (refunded_paise <= amount_paise),
  CONSTRAINT crm_revenue_payments_status_consistency CHECK (
    (status = 'captured'           AND refunded_paise = 0 AND cancelled_at IS NULL) OR
    (status = 'partially_refunded' AND refunded_paise > 0 AND refunded_paise < amount_paise
                                   AND refunded_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'refunded'           AND refunded_paise = amount_paise AND refunded_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled'          AND cancelled_at IS NOT NULL
                                   AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) >= 3))
);
-- One payment per reference, whatever its source or letter case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_revenue_payments_ref ON public.crm_revenue_payments (lower(btrim(external_ref)));
CREATE INDEX IF NOT EXISTS idx_crm_revenue_payments_date ON public.crm_revenue_payments (payment_date);
COMMENT ON TABLE public.crm_revenue_payments IS
  'Payments entered by hand or imported from CSV. Never deleted; refunds and cancellation change only the status fields.';

CREATE TABLE IF NOT EXISTS public.crm_revenue_splits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES public.crm_revenue_payments(id) ON DELETE RESTRICT,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  source          text NOT NULL CHECK (source IN ('lead_owner', 'closer', 'manual')),
  share_bp        integer NOT NULL CHECK (share_bp BETWEEN 1 AND 10000),
  amount_paise    bigint NOT NULL CHECK (amount_paise >= 0),
  refunded_paise  bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  recorded_by     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_revenue_splits_unique UNIQUE (payment_id, user_id, source),
  CONSTRAINT crm_revenue_splits_refund_le_amount CHECK (refunded_paise <= amount_paise)
);
CREATE INDEX IF NOT EXISTS idx_crm_revenue_splits_user ON public.crm_revenue_splits (user_id);
COMMENT ON TABLE public.crm_revenue_splits IS
  'Each user''s share of a payment. When a payment has splits: shares total exactly 10000 bp, amounts total exactly the payment, refunds total the payment refund (checked at commit).';

-- Totals per payment, checked at COMMIT so a split can be replaced inside one transaction.
CREATE OR REPLACE FUNCTION public.crm_revenue_check_split_totals()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; n bigint; bp bigint; amt bigint; ref bigint; p public.crm_revenue_payments%ROWTYPE;
BEGIN
  -- Separate branches: a single CASE would reference payment_id on the payments row too.
  IF TG_TABLE_NAME = 'crm_revenue_payments' THEN
    pid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    pid := OLD.payment_id;
  ELSE
    pid := NEW.payment_id;
  END IF;
  SELECT * INTO p FROM public.crm_revenue_payments WHERE id = pid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(share_bp), 0), COALESCE(sum(amount_paise), 0), COALESCE(sum(refunded_paise), 0)
    INTO n, bp, amt, ref FROM public.crm_revenue_splits WHERE payment_id = pid;
  IF n = 0 THEN RETURN NULL; END IF;   -- not split yet
  IF bp <> 10000 THEN
    RAISE EXCEPTION 'payment %: split shares total % bp; they must total exactly 10000 (100%%)', p.external_ref, bp
      USING ERRCODE = 'check_violation';
  END IF;
  IF amt <> p.amount_paise THEN
    RAISE EXCEPTION 'payment %: split amounts total % paise; they must equal the payment amount % paise', p.external_ref, amt, p.amount_paise
      USING ERRCODE = 'check_violation';
  END IF;
  IF ref <> p.refunded_paise THEN
    RAISE EXCEPTION 'payment %: split refunds total % paise; they must equal the payment refund % paise', p.external_ref, ref, p.refunded_paise
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS crm_revenue_splits_totals ON public.crm_revenue_splits;
CREATE CONSTRAINT TRIGGER crm_revenue_splits_totals AFTER INSERT OR UPDATE OR DELETE ON public.crm_revenue_splits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crm_revenue_check_split_totals();
DROP TRIGGER IF EXISTS crm_revenue_payments_totals ON public.crm_revenue_payments;
CREATE CONSTRAINT TRIGGER crm_revenue_payments_totals AFTER UPDATE ON public.crm_revenue_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crm_revenue_check_split_totals();

-- Payments: never deleted; amount, reference and date are fixed; refunds only grow; cancelled is final.
CREATE OR REPLACE FUNCTION public.crm_revenue_payments_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crm_revenue_payments rows are never deleted (cancel instead)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.external_ref, NEW.source, NEW.payment_date, NEW.amount_paise, NEW.currency, NEW.recorded_by, NEW.created_at, NEW.import_id)
     IS DISTINCT FROM
     (OLD.id, OLD.external_ref, OLD.source, OLD.payment_date, OLD.amount_paise, OLD.currency, OLD.recorded_by, OLD.created_at, OLD.import_id) THEN
    RAISE EXCEPTION 'crm_revenue_payments: reference, amount and date are fixed (cancel and record a corrected payment)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.refunded_paise < OLD.refunded_paise THEN
    RAISE EXCEPTION 'crm_revenue_payments: refunded_paise cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'crm_revenue_payments: a cancelled payment is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_revenue_payments_guard ON public.crm_revenue_payments;
CREATE TRIGGER crm_revenue_payments_guard BEFORE UPDATE OR DELETE ON public.crm_revenue_payments
  FOR EACH ROW EXECUTE FUNCTION public.crm_revenue_payments_guard();
DROP TRIGGER IF EXISTS crm_revenue_payments_no_truncate ON public.crm_revenue_payments;
CREATE TRIGGER crm_revenue_payments_no_truncate BEFORE TRUNCATE ON public.crm_revenue_payments
  FOR EACH STATEMENT EXECUTE FUNCTION public.crm_append_only();

-- Splits: only refunded_paise may change (upwards); a split may be removed to re-split a payment
-- (the commit-time totals check still applies) unless a ledger entry points at it (FK RESTRICT).
CREATE OR REPLACE FUNCTION public.crm_revenue_splits_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.crm_revenue_payments WHERE id = OLD.payment_id AND status = 'cancelled') THEN
      RAISE EXCEPTION 'crm_revenue_splits: splits of a cancelled payment are final' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.payment_id, NEW.user_id, NEW.source, NEW.share_bp, NEW.amount_paise, NEW.recorded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.payment_id, OLD.user_id, OLD.source, OLD.share_bp, OLD.amount_paise, OLD.recorded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'crm_revenue_splits: only refunded_paise may change (replace the split instead)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.refunded_paise < OLD.refunded_paise THEN
    RAISE EXCEPTION 'crm_revenue_splits: refunded_paise cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_revenue_splits_guard ON public.crm_revenue_splits;
CREATE TRIGGER crm_revenue_splits_guard BEFORE UPDATE OR DELETE ON public.crm_revenue_splits
  FOR EACH ROW EXECUTE FUNCTION public.crm_revenue_splits_guard();
DROP TRIGGER IF EXISTS crm_revenue_splits_no_truncate ON public.crm_revenue_splits;
CREATE TRIGGER crm_revenue_splits_no_truncate BEFORE TRUNCATE ON public.crm_revenue_splits
  FOR EACH STATEMENT EXECUTE FUNCTION public.crm_append_only();

-- Ledger entries can point at the split they came from (commission, when that is decided).
ALTER TABLE public.crm_user_ledger ADD COLUMN IF NOT EXISTS split_id uuid
  REFERENCES public.crm_revenue_splits(id) ON DELETE RESTRICT;

-- Revenue per user per IST month of the payment, from splits. Refunds reduce the payment's
-- month (restated, owner decision 3); cancelled payments count as zero. Same columns as 0001.
CREATE OR REPLACE VIEW public.crm_user_monthly_revenue WITH (security_invoker = true) AS
SELECT s.user_id,
       public.crm_ist_month(p.payment_date)                                         AS month_ist,
       count(*) FILTER (WHERE p.status <> 'cancelled')                              AS payments,
       COALESCE(sum(s.amount_paise)   FILTER (WHERE p.status <> 'cancelled'), 0)::bigint AS gross_share_paise,
       COALESCE(sum(s.refunded_paise) FILTER (WHERE p.status <> 'cancelled'), 0)::bigint AS refunded_paise,
       COALESCE(sum(s.amount_paise - s.refunded_paise)
                FILTER (WHERE p.status <> 'cancelled'), 0)::bigint                  AS net_revenue_paise
  FROM public.crm_revenue_splits s
  JOIN public.crm_revenue_payments p ON p.id = s.payment_id
 GROUP BY 1, 2;

COMMENT ON TABLE public.crm_revenue_attributions IS
  'SUPERSEDED by crm_revenue_payments + crm_revenue_splits (v2.1). Not written by the app; kept because migrations never drop tables.';

-- Server-only, like the rest of the module.
ALTER TABLE public.crm_revenue_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_revenue_splits   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_revenue_payments, public.crm_revenue_splits FROM wacrm_app;

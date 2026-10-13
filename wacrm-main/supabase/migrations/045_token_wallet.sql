-- ============================================================
-- 045_token_wallet — token wallet and automated-message metering
--
-- Every message an AUTOMATED path sends (AI reply, automation /
-- scheduled step, flow, broadcast recipient, public-API send) costs
-- 0.5 token. Manual agent replies are free and work at zero balance.
-- Plan and send-path inventory: docs/token-wallet/PLAN.md.
--
-- Units: 1 token = 1000 units; one charge = 500 units. All balances,
-- charges and credits are BIGINT units — never floats. Money is BIGINT
-- paise. Tokens never expire.
--
-- Tables
--   token_settings          singleton: rate (tokens per rupee as num/den,
--                           default 1/1) and GPay instructions
--   token_rate_changes      audit of every rate change
--   token_wallets           one balance per account, CHECK >= 0
--   token_ledger            append-only; every balance change is a row
--   recharge_requests       manual GPay recharges, approved by an admin
--   message_charges         one row per logical automated message
--   account_feature_flags   chatbot / workflow / ai_agent switches
--
-- All money logic lives in the SECURITY DEFINER functions below. Each
-- locks the account's wallet row (SELECT … FOR UPDATE) FIRST, so
-- concurrent sends for one account serialise and can never overspend.
-- The functions are executable by service_role only; the API routes
-- authenticate and authorise the caller in TypeScript before calling
-- them. RLS is enabled with no policies, so browser clients can't read
-- or write these tables directly.
--
-- Backfill: every existing account gets a wallet at 0 and all three
-- features switched ON (today everything always runs). NOTE: with a 0
-- balance, automated sends stop until tokens are granted or a
-- recharge is approved. Manual replies are unaffected.
--
-- Rollback: supabase/rollbacks/045_token_wallet.down.sql
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_settings (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rate_num           integer NOT NULL DEFAULT 1 CHECK (rate_num > 0 AND rate_num <= 1000000),
  rate_den           integer NOT NULL DEFAULT 1 CHECK (rate_den > 0 AND rate_den <= 1000000),
  gpay_upi_id        text CHECK (gpay_upi_id IS NULL OR length(gpay_upi_id) <= 100),
  gpay_payee_name    text CHECK (gpay_payee_name IS NULL OR length(gpay_payee_name) <= 100),
  gpay_instructions  text CHECK (gpay_instructions IS NULL OR length(gpay_instructions) <= 2000),
  updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO token_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS token_rate_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_num    integer NOT NULL,
  rate_den    integer NOT NULL,
  changed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Wallets and ledger
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_wallets (
  account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  balance_units  bigint NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entry_type           text NOT NULL CHECK (entry_type IN (
                         'grant', 'recharge_credit', 'usage_reserve', 'usage_confirm',
                         'usage_release', 'admin_deduct', 'reversal')),
  amount_units         bigint NOT NULL,
  balance_after_units  bigint NOT NULL CHECK (balance_after_units >= 0),
  actor_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason               text CHECK (reason IS NULL OR length(reason) <= 500),
  reference            text,
  rate_num             integer,
  rate_den             integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Admin entries must say why.
  CHECK (entry_type NOT IN ('grant', 'admin_deduct', 'reversal')
         OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
  -- Sign discipline per entry type.
  CHECK (
    (entry_type IN ('grant', 'recharge_credit', 'usage_release') AND amount_units > 0) OR
    (entry_type IN ('usage_reserve', 'admin_deduct') AND amount_units < 0) OR
    (entry_type = 'usage_confirm' AND amount_units = 0) OR
    (entry_type = 'reversal')
  )
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_account_time ON token_ledger(account_id, created_at DESC);
-- A recharge request can be credited once, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_ledger_recharge_reference
  ON token_ledger(reference) WHERE entry_type = 'recharge_credit';

-- Append-only. The only delete allowed is the cascade when the whole
-- account is deleted (its accounts row is already gone by then).
CREATE OR REPLACE FUNCTION public.token_ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'token_ledger is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS token_ledger_no_update_delete ON token_ledger;
CREATE TRIGGER token_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON token_ledger
  FOR EACH ROW EXECUTE FUNCTION public.token_ledger_append_only();

-- ------------------------------------------------------------
-- Recharge requests
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recharge_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  amount_paise               bigint NOT NULL CHECK (amount_paise > 0),
  rate_tokens_per_rupee_num  integer NOT NULL CHECK (rate_tokens_per_rupee_num > 0),
  rate_tokens_per_rupee_den  integer NOT NULL CHECK (rate_tokens_per_rupee_den > 0),
  tokens_units               bigint NOT NULL CHECK (tokens_units > 0),
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'rejected')),
  payment_reference          text CHECK (payment_reference IS NULL OR length(payment_reference) <= 100),
  proof_storage_key          text,
  decided_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at                 timestamptz,
  decision_note              text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR decided_at IS NOT NULL),
  CHECK (status <> 'rejected' OR (decision_note IS NOT NULL AND length(btrim(decision_note)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_recharge_requests_account ON recharge_requests(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_requests_pending ON recharge_requests(created_at) WHERE status = 'pending';

-- ------------------------------------------------------------
-- Message charges
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_charges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Logical message key (see PLAN.md §3), e.g. 'bc:<recipient id>'.
  message_id           text NOT NULL UNIQUE CHECK (length(message_id) BETWEEN 1 AND 200),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source               text NOT NULL CHECK (source IN ('ai_agent', 'chatbot', 'workflow', 'broadcast', 'api')),
  status               text NOT NULL CHECK (status IN ('reserved', 'sent', 'released', 'needs_reconciliation')),
  ledger_reserve_id    uuid REFERENCES token_ledger(id),
  provider_message_id  text,
  detail               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_charges_account_time ON message_charges(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_charges_open
  ON message_charges(updated_at) WHERE status IN ('reserved', 'needs_reconciliation');

-- ------------------------------------------------------------
-- Feature switches
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_feature_enum') THEN
    CREATE TYPE account_feature_enum AS ENUM ('chatbot', 'workflow', 'ai_agent');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS account_feature_flags (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  feature     account_feature_enum NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, feature)
);

-- ------------------------------------------------------------
-- RLS: on, no policies. Only service_role (API routes) touches these.
-- ------------------------------------------------------------
ALTER TABLE token_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_rate_changes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_wallets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_ledger          ENABLE ROW LEVEL SECURITY;
ALTER TABLE recharge_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_charges       ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_feature_flags ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Backfill + new-account bootstrap
-- ------------------------------------------------------------
INSERT INTO token_wallets (account_id)
SELECT id FROM accounts
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO account_feature_flags (account_id, feature, enabled)
SELECT a.id, f.feature, true
FROM accounts a
CROSS JOIN (VALUES ('chatbot'::account_feature_enum), ('workflow'), ('ai_agent')) AS f(feature)
ON CONFLICT (account_id, feature) DO NOTHING;

CREATE OR REPLACE FUNCTION public.token_bootstrap_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO token_wallets (account_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  INSERT INTO account_feature_flags (account_id, feature, enabled)
  VALUES (NEW.id, 'chatbot', true), (NEW.id, 'workflow', true), (NEW.id, 'ai_agent', true)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS token_bootstrap_on_account ON accounts;
CREATE TRIGGER token_bootstrap_on_account
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.token_bootstrap_account();

-- ============================================================
-- Money functions
-- ============================================================

-- Internal: lock the wallet, apply a signed delta, append a ledger row.
-- Raises 'insufficient_balance' instead of letting the balance go
-- negative. Callers that also lock a charge / request row must call
-- this (or token__lock_wallet) FIRST so lock order is always
-- wallet → row, which rules out deadlocks.
CREATE OR REPLACE FUNCTION public.token__lock_wallet(p_account_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance bigint;
BEGIN
  INSERT INTO token_wallets (account_id) VALUES (p_account_id) ON CONFLICT DO NOTHING;
  SELECT balance_units INTO v_balance FROM token_wallets
  WHERE account_id = p_account_id FOR UPDATE;
  RETURN v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.token__apply(
  p_account_id uuid,
  p_delta bigint,
  p_entry_type text,
  p_actor uuid,
  p_reason text,
  p_reference text,
  p_rate_num integer DEFAULT NULL,
  p_rate_den integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance bigint;
  v_new bigint;
  v_ledger_id uuid;
BEGIN
  v_balance := token__lock_wallet(p_account_id);
  v_new := v_balance + p_delta;
  IF v_new < 0 THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta <> 0 THEN
    UPDATE token_wallets SET balance_units = v_new, updated_at = now()
    WHERE account_id = p_account_id;
  END IF;
  INSERT INTO token_ledger (account_id, entry_type, amount_units, balance_after_units,
                            actor_user_id, reason, reference, rate_num, rate_den)
  VALUES (p_account_id, p_entry_type, p_delta, v_new,
          p_actor, NULLIF(btrim(p_reason), ''), p_reference, p_rate_num, p_rate_den)
  RETURNING id INTO v_ledger_id;
  RETURN v_ledger_id;
END;
$$;

-- Reserve 500 units for one automated message, before the send.
-- outcome: reserved | insufficient_tokens | in_flight | already_sent |
--          needs_reconciliation | key_conflict
-- Only 'reserved' means "go ahead and call the provider".
CREATE OR REPLACE FUNCTION public.token_reserve_charge(
  p_account_id uuid,
  p_message_id text,
  p_source text
) RETURNS TABLE (outcome text, charge_id uuid, balance_units bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_charge CONSTANT bigint := 500;
  v_balance bigint;
  v_charge message_charges%ROWTYPE;
  v_ledger uuid;
BEGIN
  v_balance := token__lock_wallet(p_account_id);

  SELECT * INTO v_charge FROM message_charges WHERE message_id = p_message_id FOR UPDATE;
  IF FOUND THEN
    IF v_charge.account_id <> p_account_id THEN
      RETURN QUERY SELECT 'key_conflict'::text, NULL::uuid, v_balance; RETURN;
    ELSIF v_charge.status = 'reserved' THEN
      RETURN QUERY SELECT 'in_flight'::text, v_charge.id, v_balance; RETURN;
    ELSIF v_charge.status = 'sent' THEN
      RETURN QUERY SELECT 'already_sent'::text, v_charge.id, v_balance; RETURN;
    ELSIF v_charge.status = 'needs_reconciliation' THEN
      RETURN QUERY SELECT 'needs_reconciliation'::text, v_charge.id, v_balance; RETURN;
    END IF;
    -- 'released' (definitively not sent earlier): a retry may try again
    -- on the SAME row.
  END IF;

  IF v_balance < c_charge THEN
    RETURN QUERY SELECT 'insufficient_tokens'::text, v_charge.id, v_balance; RETURN;
  END IF;

  v_ledger := token__apply(p_account_id, -c_charge, 'usage_reserve', NULL, NULL, p_message_id);

  IF v_charge.id IS NOT NULL THEN
    UPDATE message_charges
    SET status = 'reserved', ledger_reserve_id = v_ledger, provider_message_id = NULL,
        detail = NULL, updated_at = now()
    WHERE id = v_charge.id;
  ELSE
    INSERT INTO message_charges (message_id, account_id, source, status, ledger_reserve_id)
    VALUES (p_message_id, p_account_id, p_source, 'reserved', v_ledger)
    RETURNING * INTO v_charge;
  END IF;

  RETURN QUERY SELECT 'reserved'::text, v_charge.id, v_balance - c_charge;
EXCEPTION
  WHEN unique_violation THEN
    -- Same key raced in from another account.
    RETURN QUERY SELECT 'key_conflict'::text, NULL::uuid, NULL::bigint;
END;
$$;

-- Provider accepted the message. Audit-only ledger row (0 units).
-- outcome: confirmed | already_sent | not_found | invalid_state
CREATE OR REPLACE FUNCTION public.token_confirm_charge(
  p_message_id text,
  p_provider_message_id text,
  p_actor uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_charge message_charges%ROWTYPE;
BEGIN
  SELECT account_id INTO v_account FROM message_charges WHERE message_id = p_message_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM token__lock_wallet(v_account);
  SELECT * INTO v_charge FROM message_charges WHERE message_id = p_message_id FOR UPDATE;
  IF v_charge.status = 'sent' THEN RETURN 'already_sent'; END IF;
  IF v_charge.status NOT IN ('reserved', 'needs_reconciliation') THEN RETURN 'invalid_state'; END IF;
  PERFORM token__apply(v_account, 0, 'usage_confirm', p_actor, p_reason, p_message_id);
  UPDATE message_charges
  SET status = 'sent', provider_message_id = p_provider_message_id,
      detail = COALESCE(NULLIF(btrim(p_reason), ''), detail), updated_at = now()
  WHERE id = v_charge.id;
  RETURN 'confirmed';
END;
$$;

-- Provider definitively did NOT send: give the 500 units back.
-- outcome: released | already_released | not_found | invalid_state
CREATE OR REPLACE FUNCTION public.token_release_charge(
  p_message_id text,
  p_detail text,
  p_actor uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_charge message_charges%ROWTYPE;
BEGIN
  SELECT account_id INTO v_account FROM message_charges WHERE message_id = p_message_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM token__lock_wallet(v_account);
  SELECT * INTO v_charge FROM message_charges WHERE message_id = p_message_id FOR UPDATE;
  IF v_charge.status = 'released' THEN RETURN 'already_released'; END IF;
  IF v_charge.status NOT IN ('reserved', 'needs_reconciliation') THEN RETURN 'invalid_state'; END IF;
  PERFORM token__apply(v_account, 500, 'usage_release', p_actor, left(p_detail, 500), p_message_id);
  UPDATE message_charges
  SET status = 'released', detail = left(p_detail, 1000), updated_at = now()
  WHERE id = v_charge.id;
  RETURN 'released';
END;
$$;

-- Outcome unknown (timeout, dropped connection, 5xx): keep the units
-- reserved and park the charge for review. Never resent automatically.
CREATE OR REPLACE FUNCTION public.token_mark_reconciliation(
  p_message_id text,
  p_detail text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT account_id INTO v_account FROM message_charges WHERE message_id = p_message_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM token__lock_wallet(v_account);
  UPDATE message_charges
  SET status = 'needs_reconciliation', detail = left(p_detail, 1000), updated_at = now()
  WHERE message_id = p_message_id AND status = 'reserved';
  RETURN CASE WHEN FOUND THEN 'marked' ELSE 'invalid_state' END;
END;
$$;

-- Reconciliation job: charges stuck in 'reserved' (the process died
-- between reserve and outcome) are escalated to manual review.
CREATE OR REPLACE FUNCTION public.token_escalate_stale_charges(p_older_than_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE message_charges
  SET status = 'needs_reconciliation',
      detail = 'No outcome recorded within the time limit — check WhatsApp manually.',
      updated_at = now()
  WHERE status = 'reserved'
    AND updated_at < now() - make_interval(secs => p_older_than_seconds);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Super admin manual grant. Reason required. Stores the current rate.
CREATE OR REPLACE FUNCTION public.token_grant(
  p_account_id uuid,
  p_units bigint,
  p_actor uuid,
  p_reason text
) RETURNS TABLE (ledger_id uuid, balance_units bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings token_settings%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_units IS NULL OR p_units <= 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_settings FROM token_settings WHERE id = 1;
  v_id := token__apply(p_account_id, p_units, 'grant', p_actor, p_reason, NULL,
                       v_settings.rate_num, v_settings.rate_den);
  RETURN QUERY SELECT v_id, w.balance_units FROM token_wallets w WHERE w.account_id = p_account_id;
END;
$$;

-- Super admin deduction. Reason required; cannot go below zero.
CREATE OR REPLACE FUNCTION public.token_deduct(
  p_account_id uuid,
  p_units bigint,
  p_actor uuid,
  p_reason text
) RETURNS TABLE (ledger_id uuid, balance_units bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_units IS NULL OR p_units <= 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;
  v_id := token__apply(p_account_id, -p_units, 'admin_deduct', p_actor, p_reason, NULL);
  RETURN QUERY SELECT v_id, w.balance_units FROM token_wallets w WHERE w.account_id = p_account_id;
END;
$$;

-- Super admin rate change. Affects only requests submitted afterwards.
CREATE OR REPLACE FUNCTION public.token_set_rate(
  p_rate_num integer,
  p_rate_den integer,
  p_actor uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_rate_num IS NULL OR p_rate_den IS NULL OR p_rate_num <= 0 OR p_rate_den <= 0
     OR p_rate_num > 1000000 OR p_rate_den > 1000000 THEN
    RAISE EXCEPTION 'invalid_rate' USING ERRCODE = 'P0001';
  END IF;
  UPDATE token_settings SET rate_num = p_rate_num, rate_den = p_rate_den,
         updated_by = p_actor, updated_at = now()
  WHERE id = 1;
  INSERT INTO token_rate_changes (rate_num, rate_den, changed_by) VALUES (p_rate_num, p_rate_den, p_actor);
END;
$$;

-- Customer recharge request. Units are fixed at the rate in force now.
-- units = floor(paise × 10 × num / den)   (100 paise × 10 = 1000 units at 1/1)
CREATE OR REPLACE FUNCTION public.token_submit_recharge(
  p_account_id uuid,
  p_user_id uuid,
  p_amount_paise bigint,
  p_payment_reference text,
  p_proof_storage_key text
) RETURNS recharge_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings token_settings%ROWTYPE;
  v_units bigint;
  v_row recharge_requests%ROWTYPE;
BEGIN
  IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_settings FROM token_settings WHERE id = 1;
  v_units := (p_amount_paise * 10 * v_settings.rate_num) / v_settings.rate_den;
  IF v_units <= 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO recharge_requests (account_id, requested_by, amount_paise,
         rate_tokens_per_rupee_num, rate_tokens_per_rupee_den, tokens_units,
         payment_reference, proof_storage_key)
  VALUES (p_account_id, p_user_id, p_amount_paise, v_settings.rate_num, v_settings.rate_den,
          v_units, NULLIF(btrim(p_payment_reference), ''), p_proof_storage_key)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Approve or reject a recharge. Idempotent: approving an approved
-- request credits nothing. A decided request can't change.
-- outcome: approved | rejected | already_approved | already_decided | not_found
CREATE OR REPLACE FUNCTION public.token_decide_recharge(
  p_request_id uuid,
  p_actor uuid,
  p_approve boolean,
  p_note text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_req recharge_requests%ROWTYPE;
BEGIN
  SELECT account_id INTO v_account FROM recharge_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  PERFORM token__lock_wallet(v_account);
  SELECT * INTO v_req FROM recharge_requests WHERE id = p_request_id FOR UPDATE;

  IF v_req.status = 'approved' AND p_approve THEN RETURN 'already_approved'; END IF;
  IF v_req.status <> 'pending' THEN RETURN 'already_decided'; END IF;

  IF p_approve THEN
    PERFORM token__apply(v_account, v_req.tokens_units, 'recharge_credit', p_actor,
                         p_note, v_req.id::text,
                         v_req.rate_tokens_per_rupee_num, v_req.rate_tokens_per_rupee_den);
    UPDATE recharge_requests
    SET status = 'approved', decided_by = p_actor, decided_at = now(),
        decision_note = NULLIF(btrim(p_note), '')
    WHERE id = v_req.id;
    RETURN 'approved';
  END IF;

  IF p_note IS NULL OR length(btrim(p_note)) = 0 THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = 'P0001';
  END IF;
  UPDATE recharge_requests
  SET status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = btrim(p_note)
  WHERE id = v_req.id;
  RETURN 'rejected';
END;
$$;

-- ------------------------------------------------------------
-- Privileges: service_role only.
-- ------------------------------------------------------------
DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'token__lock_wallet(uuid)',
    'token__apply(uuid,bigint,text,uuid,text,text,integer,integer)',
    'token_reserve_charge(uuid,text,text)',
    'token_confirm_charge(text,text,uuid,text)',
    'token_release_charge(text,text,uuid)',
    'token_mark_reconciliation(text,text)',
    'token_escalate_stale_charges(integer)',
    'token_grant(uuid,bigint,uuid,text)',
    'token_deduct(uuid,bigint,uuid,text)',
    'token_set_rate(integer,integer,uuid)',
    'token_submit_recharge(uuid,uuid,bigint,text,text)',
    'token_decide_recharge(uuid,uuid,boolean,text)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Private bucket for GPay screenshots / PDFs (Supabase only).
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('recharge-proofs', 'recharge-proofs', FALSE, 5242880,
            ARRAY['image/png', 'image/jpeg', 'application/pdf'])
    ON CONFLICT (id) DO UPDATE
      SET public = FALSE, file_size_limit = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;

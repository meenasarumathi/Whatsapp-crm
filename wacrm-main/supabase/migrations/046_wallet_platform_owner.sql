-- ============================================================
-- 046_wallet_platform_owner — unlimited wallet for the platform owner,
-- rupee-based manual adjustments
--
-- 1. Platform owner = unlimited. An account whose owner is a platform
--    super_admin (platform_users, migration 043) is never charged for
--    automated sends. token_reserve_charge answers 'unlimited' for it:
--    the caller sends without a reservation, no message_charges row and
--    no ledger row are written, and the balance is never touched.
--    Every other account is metered exactly as in 045.
--
-- 2. token_adjust — the super admin's "Adjust Wallet" dialog works in
--    rupees. The amount is converted to units at the rate in force,
--    INSIDE the same transaction that applies it, and the rate is stored
--    on the ledger row. Credit = 'grant', debit = 'admin_deduct'; a
--    reason is required and a debit can't take the balance below zero.
--
-- 3. token_usage_summary — per-account message counts for the admin
--    table (last 30 days and all time), aggregated in SQL.
--
-- 4. token_account_status — one call that tells the app whether an
--    account is unlimited and what its balance is (used by the AI
--    pre-check and the "automated replies paused" banner).
--
-- Requires 045. Works with or without 043 (without it, nobody is a
-- platform owner and every account is metered).
-- Rollback: supabase/rollbacks/046_wallet_platform_owner.down.sql
-- Idempotent — safe to re-run.
-- ============================================================

-- Is this account owned by a platform super admin?
CREATE OR REPLACE FUNCTION public.token_is_unlimited(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result boolean := false;
BEGIN
  IF to_regclass('public.platform_users') IS NULL THEN
    RETURN false;
  END IF;
  -- Dynamic so the function still compiles where 043 isn't applied.
  EXECUTE
    'SELECT EXISTS (
       SELECT 1 FROM accounts a
       JOIN platform_users p ON p.user_id = a.owner_user_id
       WHERE a.id = $1 AND p.platform_role = ''super_admin'')'
    INTO v_result USING p_account_id;
  RETURN COALESCE(v_result, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.token_account_status(p_account_id uuid)
RETURNS TABLE (unlimited boolean, balance_units bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT token_is_unlimited(p_account_id),
         COALESCE((SELECT w.balance_units FROM token_wallets w WHERE w.account_id = p_account_id), 0);
$$;

-- Same as 045, plus the 'unlimited' outcome for the platform owner.
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
  IF token_is_unlimited(p_account_id) THEN
    RETURN QUERY SELECT 'unlimited'::text, NULL::uuid, NULL::bigint; RETURN;
  END IF;

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
    RETURN QUERY SELECT 'key_conflict'::text, NULL::uuid, NULL::bigint;
END;
$$;

-- Super admin "Adjust Wallet": credit or debit an amount in PAISE.
-- units = floor(paise × 10 × num / den) at the current rate, stored on
-- the ledger row. Returns the new balance.
CREATE OR REPLACE FUNCTION public.token_adjust(
  p_account_id uuid,
  p_kind text,
  p_amount_paise bigint,
  p_actor uuid,
  p_reason text
) RETURNS TABLE (ledger_id uuid, units bigint, balance_units bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings token_settings%ROWTYPE;
  v_units bigint;
  v_id uuid;
BEGIN
  IF p_kind NOT IN ('credit', 'debit') THEN RAISE EXCEPTION 'invalid_kind' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;
  -- Lock the settings row so the rate can't change mid-adjustment.
  SELECT * INTO v_settings FROM token_settings WHERE id = 1 FOR SHARE;
  v_units := (p_amount_paise * 10 * v_settings.rate_num) / v_settings.rate_den;
  IF v_units <= 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001'; END IF;
  v_id := token__apply(
    p_account_id,
    CASE WHEN p_kind = 'credit' THEN v_units ELSE -v_units END,
    CASE WHEN p_kind = 'credit' THEN 'grant' ELSE 'admin_deduct' END,
    p_actor, p_reason, 'inr:' || p_amount_paise::text,
    v_settings.rate_num, v_settings.rate_den);
  RETURN QUERY SELECT v_id, v_units, w.balance_units FROM token_wallets w WHERE w.account_id = p_account_id;
END;
$$;

-- Per-account message counts for the admin table, aggregated in the
-- database instead of shipping every charge row to the app.
CREATE OR REPLACE FUNCTION public.token_usage_summary(p_since timestamptz)
RETURNS TABLE (account_id uuid, messages_since bigint, messages_all bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.account_id,
         count(*) FILTER (WHERE c.created_at >= p_since),
         count(*)
  FROM message_charges c
  WHERE c.status <> 'released'
  GROUP BY c.account_id;
$$;

DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'token_usage_summary(timestamptz)',
    'token_is_unlimited(uuid)',
    'token_account_status(uuid)',
    'token_reserve_charge(uuid,text,text)',
    'token_adjust(uuid,text,bigint,uuid,text)'
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

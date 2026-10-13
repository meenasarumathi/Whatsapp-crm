-- Rollback for 046_wallet_platform_owner.sql. Run by hand.
-- Restores 045's token_reserve_charge (no unlimited platform owner) by
-- re-running the 045 function definition, then drops the new helpers.
-- Ledger rows written by token_adjust stay (they are normal grant /
-- admin_deduct entries).

DROP FUNCTION IF EXISTS public.token_adjust(uuid, text, bigint, uuid, text);
DROP FUNCTION IF EXISTS public.token_account_status(uuid);
DROP FUNCTION IF EXISTS public.token_usage_summary(timestamptz);

-- token_reserve_charge without the platform-owner check (as in 045).
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
REVOKE ALL ON FUNCTION public.token_reserve_charge(uuid, text, text) FROM PUBLIC;

DROP FUNCTION IF EXISTS public.token_is_unlimited(uuid);

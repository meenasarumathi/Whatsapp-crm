-- ============================================================
-- Rollback for 045_token_wallet.sql
--
-- This folder is NOT read by the Supabase CLI. Run it by hand in the
-- SQL editor (or psql) only when you want to remove the token wallet.
-- It DELETES every wallet, ledger row, recharge request and charge.
-- Take a backup first (Settings → Backup).
-- ============================================================

DROP TRIGGER IF EXISTS token_bootstrap_on_account ON accounts;

DROP FUNCTION IF EXISTS public.token_decide_recharge(uuid, uuid, boolean, text);
DROP FUNCTION IF EXISTS public.token_submit_recharge(uuid, uuid, bigint, text, text);
DROP FUNCTION IF EXISTS public.token_set_rate(integer, integer, uuid);
DROP FUNCTION IF EXISTS public.token_deduct(uuid, bigint, uuid, text);
DROP FUNCTION IF EXISTS public.token_grant(uuid, bigint, uuid, text);
DROP FUNCTION IF EXISTS public.token_escalate_stale_charges(integer);
DROP FUNCTION IF EXISTS public.token_mark_reconciliation(text, text);
DROP FUNCTION IF EXISTS public.token_release_charge(text, text, uuid);
DROP FUNCTION IF EXISTS public.token_confirm_charge(text, text, uuid, text);
DROP FUNCTION IF EXISTS public.token_reserve_charge(uuid, text, text);
DROP FUNCTION IF EXISTS public.token__apply(uuid, bigint, text, uuid, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.token__lock_wallet(uuid);
DROP FUNCTION IF EXISTS public.token_bootstrap_account();

DROP TABLE IF EXISTS message_charges;
DROP TABLE IF EXISTS recharge_requests;
-- The append-only trigger blocks row deletes, not DROP TABLE.
DROP TABLE IF EXISTS token_ledger;
DROP FUNCTION IF EXISTS public.token_ledger_append_only();
DROP TABLE IF EXISTS token_wallets;
DROP TABLE IF EXISTS account_feature_flags;
DROP TYPE IF EXISTS account_feature_enum;
DROP TABLE IF EXISTS token_rate_changes;
DROP TABLE IF EXISTS token_settings;

-- The private proofs bucket is left in place on purpose: deleting it
-- would destroy uploaded payment proofs. Remove it from the Supabase
-- dashboard (Storage) if you really want it gone.

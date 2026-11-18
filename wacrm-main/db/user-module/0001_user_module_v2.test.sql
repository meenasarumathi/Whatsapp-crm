-- =============================================================================
-- Tests for 0001_user_module_v2.up.sql + 0002 (v2.1), i.e. db/schema.sql. LOCAL TEST DATABASE ONLY.
-- Runs in one transaction and ROLLS BACK, so it leaves no rows behind.
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/user-module/0001_user_module_v2.test.sql
--
-- Every check prints "PASS ..." as a NOTICE; the first failure aborts with "FAIL ...".
-- =============================================================================
\set QUIET on
\o /dev/null
BEGIN;

-- expect_error(label, sql, sqlstate): the statement must fail with that SQLSTATE.
CREATE FUNCTION pg_temp.expect_error(label text, stmt text, want text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text; msg text; ok boolean := false;
BEGIN
  BEGIN
    EXECUTE stmt; ok := true;
  EXCEPTION WHEN others THEN got := SQLSTATE; msg := SQLERRM;
  END;
  IF ok THEN RAISE EXCEPTION 'FAIL %: statement succeeded but should have failed', label; END IF;
  IF want IS NOT NULL AND got <> want THEN
    RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, got % (%)', label, want, got, msg;
  END IF;
  RAISE NOTICE 'PASS %  [% %]', label, got, left(msg, 90);
END $$;

CREATE FUNCTION pg_temp.expect_ok(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS %', label;
EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'FAIL %: % (%)', label, SQLERRM, SQLSTATE;
END $$;

CREATE FUNCTION pg_temp.expect_eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got %, want %', label, got, want; END IF;
  RAISE NOTICE 'PASS %  (= %)', label, got;
END $$;

-- ---------- fixtures: three users (signup trigger creates account/profile/platform row) ----------
INSERT INTO public.users (id, email, password_hash) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'super1@test.local', 'x'),
  ('00000000-0000-0000-0000-0000000000a2', 'super2@test.local', 'x'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff1@test.local', 'x');
INSERT INTO public.platform_users (user_id) VALUES
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000b1')
ON CONFLICT (user_id) DO NOTHING;
ALTER TABLE public.platform_users DISABLE TRIGGER crm_platform_users_last_super_admin;
UPDATE public.platform_users SET platform_role = 'subscriber', subscription_status = 'active'
 WHERE user_id IN ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000b1');
-- Isolate from any super admins already in this database.
CREATE TEMP TABLE _other_supers AS
  SELECT user_id FROM public.platform_users WHERE platform_role = 'super_admin';
UPDATE public.platform_users SET platform_role = 'admin1' WHERE user_id IN (SELECT user_id FROM _other_supers);
UPDATE public.platform_users SET platform_role = 'super_admin' WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
ALTER TABLE public.platform_users ENABLE TRIGGER crm_platform_users_last_super_admin;

\set S1 '''00000000-0000-0000-0000-0000000000a1'''
\set S2 '''00000000-0000-0000-0000-0000000000a2'''
\set U  '''00000000-0000-0000-0000-0000000000b1'''

-- ============================== 1. user events: append-only + reason rules ==============================
INSERT INTO public.crm_user_events (id, subject_user_id, actor_id, event_type, reason)
VALUES ('00000000-0000-0000-0000-00000000e001', :U, :S1, 'joined', NULL);

SELECT pg_temp.expect_error('events: UPDATE rejected',
  $$UPDATE public.crm_user_events SET reason = 'x' WHERE id = '00000000-0000-0000-0000-00000000e001'$$, '42501');
SELECT pg_temp.expect_error('events: DELETE rejected',
  $$DELETE FROM public.crm_user_events WHERE id = '00000000-0000-0000-0000-00000000e001'$$, '42501');
SELECT pg_temp.expect_error('events: TRUNCATE rejected', $$TRUNCATE public.crm_user_events$$, '42501');
SELECT pg_temp.expect_error('events: access_granted needs a reason',
  format($$INSERT INTO public.crm_user_events (subject_user_id, actor_id, event_type) VALUES (%L, %L, 'access_granted')$$,
         :U, :S1), '23514');
SELECT pg_temp.expect_error('events: unknown event type rejected',
  format($$INSERT INTO public.crm_user_events (subject_user_id, event_type) VALUES (%L, 'hacked')$$, :U), '23514');
SELECT pg_temp.expect_ok('events: MFA / session / export / ledger / analyst types accepted',
  format($$INSERT INTO public.crm_user_events (subject_user_id, actor_id, event_type, reason) VALUES
     (%1$L, %1$L, 'mfa_enrolled', NULL), (%1$L, %2$L, 'mfa_reset_by_admin', 'lost phone'),
     (%1$L, %1$L, 'password_reset_completed', NULL), (%1$L, %2$L, 'all_sessions_revoked', 'device stolen'),
     (NULL, %2$L, 'export_requested', NULL), (%1$L, %2$L, 'ledger_entry_reversed', 'duplicate payout'),
     (NULL, %2$L, 'analyst_viewed', NULL)$$, :U, :S1));

-- ============================== 2. login attempts vs sessions ==============================
INSERT INTO public.crm_auth_sessions (id, user_id, expires_at)
VALUES ('00000000-0000-0000-0000-00000000c001', :U, now() + interval '7 days');
INSERT INTO public.crm_auth_login_attempts (id, user_id, attempted_email, outcome, session_id) VALUES
  ('00000000-0000-0000-0000-00000000d001', :U, 'staff1@test.local', 'success', '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000d002', NULL, 'nobody@test.local', 'unknown_user', NULL);

SELECT pg_temp.expect_error('login attempts: UPDATE rejected',
  $$UPDATE public.crm_auth_login_attempts SET outcome = 'success' WHERE id = '00000000-0000-0000-0000-00000000d002'$$, '42501');
SELECT pg_temp.expect_error('login attempts: DELETE rejected',
  $$DELETE FROM public.crm_auth_login_attempts$$, '42501');
SELECT pg_temp.expect_error('login attempts: failure may not carry a session',
  format($$INSERT INTO public.crm_auth_login_attempts (user_id, attempted_email, outcome, session_id)
           VALUES (%L, 'staff1@test.local', 'bad_password', '00000000-0000-0000-0000-00000000c001')$$, :U), '23514');
SELECT pg_temp.expect_ok('sessions: revoke sets end fields',
  format($$UPDATE public.crm_auth_sessions SET ended_at = now(), end_reason = 'revoked', revoked_by = %L
           WHERE id = '00000000-0000-0000-0000-00000000c001'$$, :S1));
SELECT pg_temp.expect_error('sessions: ended session cannot be reopened',
  $$UPDATE public.crm_auth_sessions SET ended_at = NULL, end_reason = NULL WHERE id = '00000000-0000-0000-0000-00000000c001'$$, '42501');
SELECT pg_temp.expect_error('sessions: DELETE rejected', $$DELETE FROM public.crm_auth_sessions$$, '42501');

-- ============================== 3. access grants: no overlap, revoke-only updates ==============================
INSERT INTO public.crm_access_grants (id, user_id, module, level, reason, granted_by, starts_at, expires_at)
VALUES ('00000000-0000-0000-0000-00000000f001', :U, 'leads', 'read', 'new sales hire',
        :S1, '2026-11-01 00:00+05:30', '2026-12-01 00:00+05:30');

SELECT pg_temp.expect_error('grants: overlapping grant for same user+module rejected',
  format($$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at)
           VALUES (%L, 'leads', 'write', 'upgrade', %L, '2026-11-15 00:00+05:30', '2027-01-01 00:00+05:30')$$, :U, :S1), '23P01');
SELECT pg_temp.expect_error('grants: open-ended grant overlapping a dated one rejected',
  format($$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, review_due_at)
           VALUES (%L, 'leads', 'read', 'forever', %L, '2026-10-01 00:00+05:30', '2027-01-01 00:00+05:30')$$, :U, :S1), '23P01');
SELECT pg_temp.expect_ok('grants: back-to-back grant (starts at previous expiry) allowed',
  format($$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at)
           VALUES (%L, 'leads', 'read', 'renewal', %L, '2026-12-01 00:00+05:30', '2027-01-01 00:00+05:30')$$, :U, :S1));
SELECT pg_temp.expect_ok('grants: different module same period allowed',
  format($$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at)
           VALUES (%L, 'payments', 'read', 'finance cover', %L, '2026-11-01 00:00+05:30', '2026-12-01 00:00+05:30')$$, :U, :S1));
SELECT pg_temp.expect_error('grants: changing level in place rejected',
  $$UPDATE public.crm_access_grants SET level = 'manage' WHERE id = '00000000-0000-0000-0000-00000000f001'$$, '42501');
SELECT pg_temp.expect_error('grants: extending expiry in place rejected',
  $$UPDATE public.crm_access_grants SET expires_at = '2027-06-01' WHERE id = '00000000-0000-0000-0000-00000000f001'$$, '42501');
SELECT pg_temp.expect_error('grants: revoke without reason rejected',
  format($$UPDATE public.crm_access_grants SET revoked_at = '2026-11-10 00:00+05:30', revoked_by = %L
           WHERE id = '00000000-0000-0000-0000-00000000f001'$$, :S1), '23514');
SELECT pg_temp.expect_ok('grants: revoke with reason allowed',
  format($$UPDATE public.crm_access_grants SET revoked_at = '2026-11-10 00:00+05:30', revoked_by = %L,
           revoke_reason = 'moved to marketing' WHERE id = '00000000-0000-0000-0000-00000000f001'$$, :S1));
SELECT pg_temp.expect_ok('grants: after revoke, a new grant in the freed window is allowed',
  format($$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at, replaces_grant_id)
           VALUES (%L, 'leads', 'write', 'promoted', %L, '2026-11-10 00:00+05:30', '2026-12-01 00:00+05:30',
                   '00000000-0000-0000-0000-00000000f001')$$, :U, :S1));
SELECT pg_temp.expect_error('grants: second revoke rejected',
  format($$UPDATE public.crm_access_grants SET revoked_at = now(), revoked_by = %L, revoke_reason = 'again'
           WHERE id = '00000000-0000-0000-0000-00000000f001'$$, :S1), '42501');
SELECT pg_temp.expect_error('grants: DELETE rejected', $$DELETE FROM public.crm_access_grants$$, '42501');

-- ============================== 4. revenue attribution ==============================
INSERT INTO public.crm_revenue_attributions
  (id, user_id, payment_ref, gross_amount_paise, attribution_role, share_bp, attributed_paise, paid_at, created_by)
VALUES
  ('00000000-0000-0000-0000-0000000aa001', :U,  'pay_TEST1', 1000001, 'closer',     6000, 600001, '2026-10-31 19:00+00', :S1),
  ('00000000-0000-0000-0000-0000000aa002', :S2, 'pay_TEST1', 1000001, 'lead_owner', 4000, 400000, '2026-10-31 19:00+00', :S1);

SELECT pg_temp.expect_error('revenue: shares over 100 percent rejected',
  format($$INSERT INTO public.crm_revenue_attributions (user_id, payment_ref, gross_amount_paise, attribution_role, share_bp,
           attributed_paise, paid_at, created_by) VALUES (%L, 'pay_TEST1', 1000001, 'manual', 1, 0, now(), %L)$$, :S1, :S1), '23514');
SELECT pg_temp.expect_error('revenue: refunded status needs full refund amount',
  $$UPDATE public.crm_revenue_attributions SET payment_status = 'refunded', refunded_at = now()
    WHERE id = '00000000-0000-0000-0000-0000000aa001'$$, '23514');
SELECT pg_temp.expect_ok('revenue: partial refund recorded',
  $$UPDATE public.crm_revenue_attributions SET payment_status = 'partially_refunded', refunded_paise = 100000,
    refunded_at = now() WHERE id = '00000000-0000-0000-0000-0000000aa001'$$);
SELECT pg_temp.expect_error('revenue: refund cannot decrease',
  $$UPDATE public.crm_revenue_attributions SET refunded_paise = 50000 WHERE id = '00000000-0000-0000-0000-0000000aa001'$$, '23514');
SELECT pg_temp.expect_error('revenue: changing the share after the fact rejected',
  $$UPDATE public.crm_revenue_attributions SET attributed_paise = 700000 WHERE id = '00000000-0000-0000-0000-0000000aa001'$$, '42501');
SELECT pg_temp.expect_error('revenue: cancel needs a reason',
  $$UPDATE public.crm_revenue_attributions SET payment_status = 'cancelled', cancelled_at = now()
    WHERE id = '00000000-0000-0000-0000-0000000aa002'$$, '23514');
SELECT pg_temp.expect_ok('revenue: cancel with reason',
  $$UPDATE public.crm_revenue_attributions SET payment_status = 'cancelled', cancelled_at = now(),
    cancel_reason = 'chargeback' WHERE id = '00000000-0000-0000-0000-0000000aa002'$$);
SELECT pg_temp.expect_error('revenue: DELETE rejected', $$DELETE FROM public.crm_revenue_attributions$$, '42501');

-- Revenue report (v2.1 reads payments + splits).
-- 2026-10-31 19:00 UTC is 2026-11-01 00:30 IST → November in IST, October in UTC.
INSERT INTO public.crm_revenue_payments (id, external_ref, source, payment_date, amount_paise, recorded_by) VALUES
  ('00000000-0000-0000-0000-0000000cc001', 'pay_V1', 'manual', '2026-10-31 19:00+00', 1000001, :S1),
  ('00000000-0000-0000-0000-0000000cc002', 'pay_V2', 'manual', '2026-10-31 19:00+00', 5000, :S1);
INSERT INTO public.crm_revenue_splits (payment_id, user_id, source, share_bp, amount_paise, recorded_by) VALUES
  ('00000000-0000-0000-0000-0000000cc001', :U,  'closer',     6000, 600001, :S1),
  ('00000000-0000-0000-0000-0000000cc001', :S2, 'lead_owner', 4000, 400000, :S1),
  ('00000000-0000-0000-0000-0000000cc002', :S2, 'closer',    10000,   5000, :S1);
UPDATE public.crm_revenue_payments SET status = 'partially_refunded', refunded_paise = 100000, refunded_at = now()
 WHERE id = '00000000-0000-0000-0000-0000000cc001';
UPDATE public.crm_revenue_splits SET refunded_paise = 100000
 WHERE payment_id = '00000000-0000-0000-0000-0000000cc001' AND user_id = :U;
UPDATE public.crm_revenue_payments SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'chargeback'
 WHERE id = '00000000-0000-0000-0000-0000000cc002';
SELECT pg_temp.expect_ok('revenue: split totals hold at commit time', 'SET CONSTRAINTS ALL IMMEDIATE');
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_eq('IST month: 19:00 UTC on 31 Oct counts as November',
  (SELECT month_ist FROM public.crm_user_monthly_revenue WHERE user_id = :U), DATE '2026-11-01');
SELECT pg_temp.expect_eq('revenue: net = share - refund',
  (SELECT net_revenue_paise FROM public.crm_user_monthly_revenue WHERE user_id = :U), 500001::bigint);
SELECT pg_temp.expect_eq('revenue: a cancelled payment counts as zero',
  (SELECT net_revenue_paise FROM public.crm_user_monthly_revenue WHERE user_id = :S2), 400000::bigint);

-- ============================== 5. ledger: append-only + reversal rules ==============================
INSERT INTO public.crm_user_ledger (id, user_id, entry_type, amount_paise, attribution_id, idempotency_key, created_by) VALUES
  ('00000000-0000-0000-0000-0000000bb001', :U, 'commission', 50000, '00000000-0000-0000-0000-0000000aa001', 'seed-1', :S1);
INSERT INTO public.crm_user_ledger (id, user_id, entry_type, amount_paise, reference, idempotency_key, created_by) VALUES
  ('00000000-0000-0000-0000-0000000bb002', :U, 'payout', -20000, 'UTR123', 'seed-2', :S1);

SELECT pg_temp.expect_error('ledger: UPDATE rejected',
  $$UPDATE public.crm_user_ledger SET amount_paise = 1 WHERE id = '00000000-0000-0000-0000-0000000bb001'$$, '42501');
SELECT pg_temp.expect_error('ledger: DELETE rejected', $$DELETE FROM public.crm_user_ledger$$, '42501');
SELECT pg_temp.expect_error('ledger: TRUNCATE rejected', $$TRUNCATE public.crm_user_ledger$$, '42501');
SELECT pg_temp.expect_error('ledger: payout must be negative',
  format($$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, idempotency_key, created_by) VALUES (%L, 'payout', 100, 't1-1', %L)$$, :U, :S1), '23514');
SELECT pg_temp.expect_error('ledger: reversal needs reversal_of',
  format($$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, created_by) VALUES (%L, 'reversal', 20000, 'oops', 't1-2', %L)$$, :U, :S1), '23514');
SELECT pg_temp.expect_error('ledger: reversal with wrong amount rejected',
  format($$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reversal_of, reason, idempotency_key, created_by) VALUES (%L, 'reversal', 19999, '00000000-0000-0000-0000-0000000bb002', 'duplicate payout', 't1-3', %L)$$, :U, :S1), '23514');
SELECT pg_temp.expect_ok('ledger: exact reversal accepted',
  format($$INSERT INTO public.crm_user_ledger (id, user_id, entry_type, amount_paise, reversal_of, reason, idempotency_key, created_by) VALUES ('00000000-0000-0000-0000-0000000bb003', %L, 'reversal', 20000, '00000000-0000-0000-0000-0000000bb002',
                   'duplicate payout', 't1-4', %L)$$, :U, :S1));
SELECT pg_temp.expect_error('ledger: second reversal of same entry rejected',
  format($$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reversal_of, reason, idempotency_key, created_by) VALUES (%L, 'reversal', 20000, '00000000-0000-0000-0000-0000000bb002', 'again', 't1-5', %L)$$, :U, :S1), '23505');
SELECT pg_temp.expect_error('ledger: reversing a reversal rejected',
  format($$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reversal_of, reason, idempotency_key, created_by) VALUES (%L, 'reversal', -20000, '00000000-0000-0000-0000-0000000bb003', 'undo undo', 't1-6', %L)$$, :U, :S1), '23514');
SELECT pg_temp.expect_eq('ledger: balance = 50000 - 20000 + 20000',
  (SELECT balance_paise FROM public.crm_user_balance WHERE user_id = :U), 50000::bigint);

-- ============================== 6. users with history cannot be deleted ==============================
-- (Deleting a real user is already blocked by accounts_owner_user_id_fkey, so check our FKs in the catalog.)
SELECT pg_temp.expect_eq('history FKs: every FK on audit/financial tables is ON DELETE RESTRICT',
  (SELECT count(*) FROM pg_constraint c
    WHERE c.contype = 'f' AND c.confdeltype <> 'r'
      AND c.conrelid::regclass::text IN ('crm_user_events', 'crm_user_ledger', 'crm_revenue_attributions',
            'crm_access_grants', 'crm_auth_login_attempts', 'crm_auth_sessions', 'crm_user_profiles',
            'crm_notification_deliveries', 'crm_jobs', 'crm_user_imports', 'crm_user_import_rows')), 0::bigint);

-- ============================== 7. last Super Admin protection ==============================
SELECT pg_temp.expect_error('super admin: demoting the only super admin rejected',
  format($$UPDATE public.platform_users SET platform_role = 'admin1' WHERE user_id = %L$$, :S1), '23514');
SELECT pg_temp.expect_error('super admin: suspending the only super admin rejected',
  format($$UPDATE public.platform_users SET subscription_status = 'suspended' WHERE user_id = %L$$, :S1), '23514');
SELECT pg_temp.expect_error('super admin: deleting the only super admin row rejected',
  format($$DELETE FROM public.platform_users WHERE user_id = %L$$, :S1), '23514');
INSERT INTO public.crm_user_profiles (user_id, job_role) VALUES (:S1, NULL);
SELECT pg_temp.expect_error('super admin: marking the only super admin as left rejected',
  format($$UPDATE public.crm_user_profiles SET lifecycle_status = 'left', left_at = now() WHERE user_id = %L$$, :S1), '23514');
SELECT pg_temp.expect_ok('super admin: promote a second super admin',
  format($$UPDATE public.platform_users SET platform_role = 'super_admin' WHERE user_id = %L$$, :S2));
SELECT pg_temp.expect_ok('super admin: now the first one can be demoted',
  format($$UPDATE public.platform_users SET platform_role = 'admin1' WHERE user_id = %L$$, :S1));
SELECT pg_temp.expect_error('super admin: and the remaining one is protected again',
  format($$UPDATE public.platform_users SET platform_role = 'admin2' WHERE user_id = %L$$, :S2), '23514');

-- ============================== 8. RLS: the app role sees nothing ==============================
GRANT SELECT ON public.crm_user_balance, public.crm_user_ledger TO wacrm_app;  -- what db:init's blanket GRANT would do
SET LOCAL ROLE wacrm_app;
SELECT pg_temp.expect_eq('RLS: wacrm_app reads 0 ledger rows even with a table GRANT',
  (SELECT count(*) FROM public.crm_user_ledger), 0::bigint);
SELECT pg_temp.expect_error('RLS: wacrm_app cannot read the balance view (security_invoker)',
  $$SELECT count(*) FROM public.crm_user_balance$$, '42501');
RESET ROLE;

-- ============================== 9. monthly movement view ==============================
SELECT pg_temp.expect_eq('movement: joined counted in its IST month',
  (SELECT joined FROM public.crm_monthly_user_movement WHERE month_ist = public.crm_ist_month(now())), 1::bigint);

\echo 'ALL USER-MODULE v2 TESTS PASSED (rolling back)'
ROLLBACK;

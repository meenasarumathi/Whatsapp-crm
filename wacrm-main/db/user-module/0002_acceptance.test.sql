-- =============================================================
-- ACCEPTANCE TESTS (owner's test, 13 Nov 2026) adapted to the built schema
-- (0001 + 0002, or db/schema.sql). LOCAL TEST DATABASE ONLY.
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/user-module/0002_acceptance.test.sql
--
-- Table mapping from the original test:
--   crm_users            -> users + platform_users (role) + crm_user_profiles (status)
--   crm_user_events.user_id -> crm_user_events.subject_user_id
--   crm_ledger_entries   -> crm_user_ledger   (note -> reason)
--   crm_revenue_payments / crm_revenue_splits -> same names (added in 0002)
--   role 'no_access'     -> no role: a user with no access grants sees no modules
--
-- Difference from the original helpers: expect_fail also checks the SQLSTATE,
-- so a typo or a missing table can never count as PASS.
-- Everything rolls back at the end.
-- =============================================================
\set QUIET on
\o /dev/null
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.expect_fail(stmt text, label text, want_state text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE got text; msg text; ok boolean := false;
BEGIN
  BEGIN
    EXECUTE stmt; ok := true;
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE; msg := SQLERRM;
  END;
  IF ok THEN RAISE EXCEPTION 'FAIL: % was allowed but should be blocked', label; END IF;
  IF got <> want_state THEN
    RAISE EXCEPTION 'FAIL: % failed for the wrong reason: % % (expected %)', label, got, msg, want_state;
  END IF;
  RAISE NOTICE 'PASS: % blocked (%)', label, left(msg, 110);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS: % allowed', label;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FAIL: % should be allowed but was blocked (%)', label, SQLERRM;
END $$;

-- ---------- Fixtures ----------
-- Users (the signup trigger also creates their account, profile and platform row).
INSERT INTO public.users (id, email, password_hash) VALUES
  ('10000000-0000-0000-0000-000000000001', 'super@test.local', 'x'),
  ('10000000-0000-0000-0000-000000000002', 'rep@test.local',   'x');
-- Make Super Admin the only active super_admin in this transaction; Sales Rep has no
-- role beyond subscriber and no grants (= the original 'no_access').
ALTER TABLE public.platform_users DISABLE TRIGGER crm_platform_users_last_super_admin;
INSERT INTO public.platform_users (user_id) VALUES
  ('10000000-0000-0000-0000-000000000001'), ('10000000-0000-0000-0000-000000000002')
ON CONFLICT (user_id) DO NOTHING;
UPDATE public.platform_users SET platform_role = 'admin1' WHERE platform_role = 'super_admin';
UPDATE public.platform_users SET platform_role = 'super_admin', subscription_status = 'active'
 WHERE user_id = '10000000-0000-0000-0000-000000000001';
UPDATE public.platform_users SET platform_role = 'subscriber', subscription_status = 'active'
 WHERE user_id = '10000000-0000-0000-0000-000000000002';
ALTER TABLE public.platform_users ENABLE TRIGGER crm_platform_users_last_super_admin;
INSERT INTO public.crm_user_profiles (user_id, job_role, lifecycle_status) VALUES
  ('10000000-0000-0000-0000-000000000001', NULL, 'active'),
  ('10000000-0000-0000-0000-000000000002', 'sales', 'active');

-- ---------- Last super admin protection ----------
SELECT pg_temp.expect_fail(
  $q$UPDATE public.platform_users SET platform_role = 'admin1' WHERE user_id = '10000000-0000-0000-0000-000000000001'$q$,
  'demoting the last active super_admin', '23514');

-- ---------- Access grants ----------
SELECT pg_temp.expect_ok(
  $q$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at, review_due_at)
     VALUES ('10000000-0000-0000-0000-000000000002', 'leads', 'write', 'Lead follow-up',
             '10000000-0000-0000-0000-000000000001', now(), now() + interval '30 days', NULL)$q$,
  'first time-limited grant');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at, review_due_at)
     VALUES ('10000000-0000-0000-0000-000000000002', 'leads', 'read', 'Overlap test',
             '10000000-0000-0000-0000-000000000001', now() + interval '1 day', now() + interval '10 days', NULL)$q$,
  'overlapping grant for the same user and module', '23P01');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at, review_due_at)
     VALUES ('10000000-0000-0000-0000-000000000002', 'payments', 'read', '',
             '10000000-0000-0000-0000-000000000001', now(), now() + interval '5 days', NULL)$q$,
  'grant with empty reason', '23514');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at, review_due_at)
     VALUES ('10000000-0000-0000-0000-000000000002', 'reports', 'read', 'Open-ended without review date',
             '10000000-0000-0000-0000-000000000001', now(), NULL, NULL)$q$,
  'open-ended grant without a review date', '23514');

SELECT pg_temp.expect_ok(
  $q$INSERT INTO public.crm_access_grants (user_id, module, level, reason, granted_by, starts_at, expires_at, review_due_at)
     VALUES ('10000000-0000-0000-0000-000000000002', 'reports', 'read', 'Open-ended with a review date',
             '10000000-0000-0000-0000-000000000001', now(), NULL, now() + interval '90 days')$q$,
  'open-ended grant with a review date');

-- ---------- Audit tables are append-only ----------
INSERT INTO public.crm_user_events (subject_user_id, event_type, reason, actor_id)
VALUES ('10000000-0000-0000-0000-000000000002', 'joined', NULL, '10000000-0000-0000-0000-000000000001');

SELECT pg_temp.expect_fail($q$UPDATE public.crm_user_events SET reason = 'edited'$q$, 'updating an audit event', '42501');
SELECT pg_temp.expect_fail($q$DELETE FROM public.crm_user_events$q$, 'deleting an audit event', '42501');
SELECT pg_temp.expect_fail($q$TRUNCATE public.crm_user_events$q$, 'truncating the audit table', '42501');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_events (subject_user_id, event_type, reason, actor_id)
     VALUES ('10000000-0000-0000-0000-000000000002', 'suspended', NULL, '10000000-0000-0000-0000-000000000001')$q$,
  'suspension event without a reason', '23514');

-- ---------- Ledger ----------
SELECT pg_temp.expect_ok(
  $q$INSERT INTO public.crm_user_ledger (id, user_id, entry_type, amount_paise, reason, idempotency_key, created_by)
     VALUES ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
             'adjustment', 50000, 'Opening balance', 'adj-1', '10000000-0000-0000-0000-000000000001')$q$,
  'opening adjustment credit');

SELECT pg_temp.expect_ok(
  $q$INSERT INTO public.crm_user_ledger (id, user_id, entry_type, amount_paise, reason, idempotency_key, created_by)
     VALUES ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
             'payout', -20000, 'March payout', 'pay-1', '10000000-0000-0000-0000-000000000001')$q$,
  'payout within balance');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'payout', -100000, 'Overdraw', 'pay-2',
             '10000000-0000-0000-0000-000000000001')$q$,
  'payout that overdraws the balance without override', '23514');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'payout', 1000, 'Positive payout', 'pay-3',
             '10000000-0000-0000-0000-000000000001')$q$,
  'payout with a positive amount', '23514');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'adjustment', 500, '', 'adj-2',
             '10000000-0000-0000-0000-000000000001')$q$,
  'adjustment without a note', '23514');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'adjustment', 500, 'Retry of opening balance', 'adj-1',
             '10000000-0000-0000-0000-000000000001')$q$,
  'reusing an idempotency key (double posting)', '23505');

SELECT pg_temp.expect_ok(
  $q$INSERT INTO public.crm_user_ledger (id, user_id, entry_type, amount_paise, reversal_of, reason, idempotency_key, created_by)
     VALUES ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002',
             'reversal', 20000, '20000000-0000-0000-0000-000000000002', 'Wrong payout reversed', 'rev-1',
             '10000000-0000-0000-0000-000000000001')$q$,
  'reversal mirroring the original payout');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reversal_of, reason, idempotency_key, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'reversal', 20000,
             '20000000-0000-0000-0000-000000000002', 'Second reversal', 'rev-2',
             '10000000-0000-0000-0000-000000000001')$q$,
  'second reversal of the same entry', '23505');

SELECT pg_temp.expect_fail(
  $q$UPDATE public.crm_user_ledger SET amount_paise = 1 WHERE id = '20000000-0000-0000-0000-000000000001'$q$,
  'editing a ledger entry', '42501');

SELECT pg_temp.expect_fail(
  $q$DELETE FROM public.crm_user_ledger WHERE id = '20000000-0000-0000-0000-000000000001'$q$,
  'deleting a ledger entry', '42501');

SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, allow_overdraw, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'payout', -100000, '', 'pay-4', true,
             '10000000-0000-0000-0000-000000000001')$q$,
  'overdraw override without a reason', '23514');

SELECT pg_temp.expect_ok(
  $q$INSERT INTO public.crm_user_ledger (user_id, entry_type, amount_paise, reason, idempotency_key, allow_overdraw, created_by)
     VALUES ('10000000-0000-0000-0000-000000000002', 'payout', -100000, 'Advance approved by Super Admin', 'pay-5', true,
             '10000000-0000-0000-0000-000000000001')$q$,
  'overdraw with an explicit override and reason');

-- ---------- Revenue splits must total 100% ----------
INSERT INTO public.crm_revenue_payments (id, external_ref, payment_date, amount_paise, status, source, recorded_by)
VALUES ('30000000-0000-0000-0000-000000000001', 'pay_test_1', now(), 10001, 'captured', 'manual',
        '10000000-0000-0000-0000-000000000001');

-- Two splits that total 100% with largest-remainder rounding: 6001 + 4000 = 10001
INSERT INTO public.crm_revenue_splits (payment_id, user_id, share_bp, amount_paise, source, recorded_by)
VALUES ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 6000, 6001, 'closer',
        '10000000-0000-0000-0000-000000000001'),
       ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 4000, 4000, 'manual',
        '10000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_ok('SET CONSTRAINTS ALL IMMEDIATE', 'splits totalling 100% and the payment amount');
SET CONSTRAINTS ALL DEFERRED;

-- Shares that total only 50% are blocked
INSERT INTO public.crm_revenue_payments (id, external_ref, payment_date, amount_paise, status, source, recorded_by)
VALUES ('30000000-0000-0000-0000-000000000002', 'pay_test_2', now(), 5000, 'captured', 'manual',
        '10000000-0000-0000-0000-000000000001');
INSERT INTO public.crm_revenue_splits (payment_id, user_id, share_bp, amount_paise, source, recorded_by)
VALUES ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 5000, 2500, 'closer',
        '10000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail('SET CONSTRAINTS ALL IMMEDIATE', 'splits totalling only 50%', '23514');
SET CONSTRAINTS ALL DEFERRED;
-- Remove that split so the next check is about its own payment only.
DELETE FROM public.crm_revenue_splits WHERE payment_id = '30000000-0000-0000-0000-000000000002';
SELECT pg_temp.expect_ok('SET CONSTRAINTS ALL IMMEDIATE', 'an unsplit payment is allowed (not attributed yet)');
SET CONSTRAINTS ALL DEFERRED;

-- Shares total 100% but the amounts do not add up to the payment
INSERT INTO public.crm_revenue_payments (id, external_ref, payment_date, amount_paise, status, source, recorded_by)
VALUES ('30000000-0000-0000-0000-000000000003', 'pay_test_3', now(), 1000, 'captured', 'manual',
        '10000000-0000-0000-0000-000000000001');
INSERT INTO public.crm_revenue_splits (payment_id, user_id, share_bp, amount_paise, source, recorded_by)
VALUES ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 10000, 999, 'closer',
        '10000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail('SET CONSTRAINTS ALL IMMEDIATE', 'split amounts not equal to the payment amount', '23514');
SET CONSTRAINTS ALL DEFERRED;

-- Duplicate payment reference is blocked (any source, any letter case or surrounding spaces)
SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_revenue_payments (external_ref, payment_date, amount_paise, status, source, recorded_by)
     VALUES ('pay_test_1', now(), 100, 'captured', 'csv_import', '10000000-0000-0000-0000-000000000001')$q$,
  'duplicate payment reference', '23505');
SELECT pg_temp.expect_fail(
  $q$INSERT INTO public.crm_revenue_payments (external_ref, payment_date, amount_paise, status, source, recorded_by)
     VALUES (' PAY_TEST_1 ', now(), 100, 'captured', 'csv_import', '10000000-0000-0000-0000-000000000001')$q$,
  'duplicate payment reference in other case / with spaces', '23505');

SELECT pg_temp.expect_fail(
  $q$DELETE FROM public.crm_revenue_payments WHERE id = '30000000-0000-0000-0000-000000000001'$q$,
  'deleting a payment', '42501');

\o
\echo 'ACCEPTANCE RUN COMPLETE: every case behaved as expected (rolling back)'
ROLLBACK;

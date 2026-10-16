-- Post-apply assertions for the "Database" CI job (.github/workflows/ci.yml) and for
-- anyone checking a freshly initialised database:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/verify-schema.sql
-- Keep it thin: a smoke test that db/schema.sql actually built the schema, not a spec of it.
DO $$
DECLARE
  missing text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','password_reset_tokens','accounts','profiles','account_invitations','member_presence','platform_users',
    'whatsapp_config','message_templates','contacts','tags','contact_tags','custom_fields','contact_custom_values','contact_notes',
    'conversations','messages','message_reactions','quick_replies','pipelines','pipeline_stages','deals',
    'broadcasts','broadcast_recipients','automations','automation_steps','automation_logs','automation_pending_executions',
    'flows','flow_nodes','flow_runs','flow_run_events','ai_configs','ai_knowledge_documents','ai_knowledge_chunks',
    'ai_usage_log','ai_training_profiles','ai_training_examples','api_keys','webhook_endpoints','notifications','db_maintenance_log'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := array_append(missing, t); END IF;
  END LOOP;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'tables missing: %', array_to_string(missing, ', ');
  END IF;

  -- Row Level Security must be on for tenant data.
  FOREACH t IN ARRAY ARRAY['contacts','conversations','messages','accounts','profiles','api_keys'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'row level security is not enabled on %', t;
    END IF;
  END LOOP;

  -- The application role and the helper the policies call.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wacrm_app') THEN RAISE EXCEPTION 'role wacrm_app is missing'; END IF;
  IF to_regprocedure('public.is_account_member(uuid, account_role_enum)') IS NULL THEN RAISE EXCEPTION 'is_account_member() is missing'; END IF;
  IF to_regprocedure('public.current_user_id()') IS NULL THEN RAISE EXCEPTION 'current_user_id() is missing'; END IF;

  -- New users get an account + profile, and live updates are wired.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_user_created') THEN RAISE EXCEPTION 'trigger on_user_created is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notify_messages') THEN RAISE EXCEPTION 'trigger notify_messages is missing'; END IF;
END $$;
SELECT 'schema OK: ' || count(*) || ' tables' AS result FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

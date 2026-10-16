-- ============================================================
-- 045_db_config  (REBUILT — see note)
--
-- NOTE: the original file was lost from the working folder on
-- 2026-10-16 (it had never been committed). This version was rebuilt
-- from the TypeScript that calls it (src/lib/db-config/*,
-- src/app/api/db-config/*, src/app/api/backup/route.ts) and from the
-- parts of the original that were read before the loss. The three
-- functions keep the same names, arguments and return shapes the app
-- expects; db_config_tables() is the original text.
--
-- Backs Settings → Backup → "Database config" (Super admin only):
--
--   db_config_tables()      every table in the public schema with its
--                           columns (type, null, default, key), exact
--                           row count, RLS flag and foreign-key links.
--   db_config_schema_sql()  the public schema as one runnable SQL script.
--   db_config_truncate()    TRUNCATE the given tables (no CASCADE — the
--                           caller must list every dependent table) and
--                           return the row counts removed.
--   db_maintenance_log      who truncated what, and when.
--
-- The three functions are SECURITY DEFINER and executable ONLY by the
-- service role, so the browser (anon / authenticated) can never reach
-- them through PostgREST. Truncate refuses accounts, profiles,
-- platform_users and db_maintenance_log.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS db_maintenance_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action              text NOT NULL,
  tables              text[] NOT NULL DEFAULT '{}',
  row_counts          jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_by_email  text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_db_maintenance_log_created
  ON db_maintenance_log (created_at DESC);

-- RLS on with no policies: only the service role (which bypasses RLS)
-- can read or write the log.
ALTER TABLE db_maintenance_log ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- db_config_tables()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.db_config_tables()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT coalesce(jsonb_agg(t.obj ORDER BY t.obj->>'name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'name', c.relname,
      'rls', c.relrowsecurity,
      'rows', (
        xpath(
          '/row/c/text()',
          query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')
        )
      )[1]::text::bigint,
      'columns', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'nullable', NOT a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'primary_key', EXISTS (
            SELECT 1 FROM pg_constraint pk
            WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY (pk.conkey)
          ),
          'generated', a.attgenerated <> '',
          'identity', a.attidentity <> ''
        ) ORDER BY a.attnum), '[]'::jsonb)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ),
      'references', (
        SELECT coalesce(jsonb_agg(DISTINCT rc.relname), '[]'::jsonb)
        FROM pg_constraint f
        JOIN pg_class rc ON rc.oid = f.confrelid
        JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE f.conrelid = c.oid AND f.contype = 'f'
          AND rn.nspname = 'public' AND f.confrelid <> c.oid
      ),
      'referenced_by', (
        SELECT coalesce(jsonb_agg(DISTINCT cc.relname), '[]'::jsonb)
        FROM pg_constraint f
        JOIN pg_class cc ON cc.oid = f.conrelid
        JOIN pg_namespace cn ON cn.oid = cc.relnamespace
        WHERE f.confrelid = c.oid AND f.contype = 'f'
          AND cn.nspname = 'public' AND f.conrelid <> c.oid
      )
    ) AS obj
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ) t;
$fn$;

-- ------------------------------------------------------------
-- db_config_schema_sql()  (rebuilt)
-- Order: extensions, enums, tables, functions (bodies unchecked),
-- constraints, foreign keys, indexes, triggers, RLS + policies.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.db_config_schema_sql()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  out  text := '';
  r    record;
  cols text;
BEGIN
  out := out || E'-- Schema of the "public" schema, generated by wacrm (Settings > Backup).\n';
  out := out || E'-- Run it in the Supabase SQL editor of an empty project to recreate the structure.\n';
  out := out || E'SET check_function_bodies = off;\n\n';

  FOR r IN SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql') ORDER BY 1 LOOP
    out := out || format(E'CREATE EXTENSION IF NOT EXISTS %I;\n', r.extname);
  END LOOP;
  out := out || E'\n';

  -- enums
  FOR r IN
    SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY 1
  LOOP
    out := out || format(E'DO $$ BEGIN CREATE TYPE public.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n', r.typname, r.labels);
  END LOOP;
  out := out || E'\n';

  -- sequences owned by no column (rare); skipped: serial/identity columns are in the table text.

  -- tables (columns only)
  FOR r IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
  LOOP
    SELECT string_agg(
             format('  %I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                    CASE WHEN a.attgenerated <> '' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                         WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END,
                    CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END),
             E',\n' ORDER BY a.attnum)
      INTO cols
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped;
    out := out || format(E'CREATE TABLE IF NOT EXISTS public.%I (\n%s\n);\n\n', r.relname, cols);
  END LOOP;

  -- functions (after tables: some take table row types)
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY p.proname
  LOOP
    out := out || pg_get_functiondef(r.oid) || E';\n\n';
  END LOOP;

  -- constraints: primary / unique / check first, foreign keys last
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('p', 'u', 'c')
    ORDER BY c.conrelid::regclass::text, c.contype, c.conname
  LOOP
    out := out || format(E'DO $$ BEGIN ALTER TABLE %s ADD CONSTRAINT %I %s; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;\n', r.tbl, r.conname, r.def);
  END LOOP;
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.connamespace = 'public'::regnamespace AND c.contype = 'f'
    ORDER BY c.conrelid::regclass::text, c.conname
  LOOP
    out := out || format(E'DO $$ BEGIN ALTER TABLE %s ADD CONSTRAINT %I %s; EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n', r.tbl, r.conname, r.def);
  END LOOP;
  out := out || E'\n';

  -- indexes that are not backing a constraint
  FOR r IN
    SELECT i.indexdef FROM pg_indexes i
    WHERE i.schemaname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname AND c.connamespace = 'public'::regnamespace)
    ORDER BY i.tablename, i.indexname
  LOOP
    out := out || replace(r.indexdef, 'CREATE INDEX', 'CREATE INDEX IF NOT EXISTS') || E';\n';
  END LOOP;
  out := out || E'\n';

  -- triggers
  FOR r IN
    SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname, t.tgname
  LOOP
    out := out || r.def || E';\n';
  END LOOP;
  out := out || E'\n';

  -- RLS + policies
  FOR r IN
    SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1
  LOOP
    out := out || format(E'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;\n', r.relname);
  END LOOP;
  FOR r IN
    SELECT p.polname, c.relname, p.polcmd, p.polpermissive,
           pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w,
           (SELECT string_agg(quote_ident(rolname), ', ') FROM pg_roles WHERE oid = ANY (p.polroles)) AS roles
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace ORDER BY c.relname, p.polname
  LOOP
    out := out || format(E'DROP POLICY IF EXISTS %I ON public.%I;\nCREATE POLICY %I ON public.%I AS %s FOR %s%s%s%s;\n',
      r.polname, r.relname, r.polname, r.relname,
      CASE WHEN r.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE r.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      CASE WHEN r.roles IS NOT NULL THEN ' TO ' || r.roles ELSE '' END,
      CASE WHEN r.q IS NOT NULL THEN ' USING (' || r.q || ')' ELSE '' END,
      CASE WHEN r.w IS NOT NULL THEN ' WITH CHECK (' || r.w || ')' ELSE '' END);
  END LOOP;

  RETURN out;
END;
$fn$;

-- ------------------------------------------------------------
-- db_config_truncate(p_tables)  (rebuilt)
-- TRUNCATE … RESTART IDENTITY, never CASCADE. Returns {table: rows removed}.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.db_config_truncate(p_tables text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  t       text;
  n       bigint;
  counts  jsonb := '{}'::jsonb;
  locked  constant text[] := ARRAY['accounts', 'profiles', 'platform_users', 'db_maintenance_log'];
BEGIN
  IF p_tables IS NULL OR cardinality(p_tables) = 0 THEN
    RAISE EXCEPTION 'No tables given' USING ERRCODE = '22023';
  END IF;

  FOREACH t IN ARRAY p_tables LOOP
    IF t = ANY (locked) THEN
      RAISE EXCEPTION 'Table % is protected and cannot be truncated', t USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = t
    ) THEN
      RAISE EXCEPTION 'Unknown table %', t USING ERRCODE = '42P01';
    END IF;
  END LOOP;

  FOREACH t IN ARRAY p_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    counts := counts || jsonb_build_object(t, n);
  END LOOP;

  -- One statement so Postgres can accept a set that references itself.
  -- No CASCADE: a table still referenced from outside the list makes
  -- Postgres refuse, which the route reports as a 409.
  EXECUTE 'TRUNCATE TABLE ' ||
    (SELECT string_agg(format('public.%I', x), ', ') FROM unnest(p_tables) AS x) ||
    ' RESTART IDENTITY';

  RETURN counts;
END;
$fn$;

-- Service role only.
REVOKE ALL ON FUNCTION public.db_config_tables()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.db_config_schema_sql()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.db_config_truncate(text[])   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.db_config_tables()          TO service_role;
GRANT EXECUTE ON FUNCTION public.db_config_schema_sql()      TO service_role;
GRANT EXECUTE ON FUNCTION public.db_config_truncate(text[])  TO service_role;

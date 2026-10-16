-- ============================================================================
-- 00_supabase_stubs.sql — OPTIONAL. Only for plain PostgreSQL (NOT Supabase).
--
-- wacrm_schema.sql depends on a few Supabase objects: the auth schema (users,
-- uid(), role()), the storage schema (buckets, objects, foldername()), the
-- roles anon / authenticated / service_role and the supabase_realtime
-- publication. A Supabase project already has all of them — skip this file.
--
-- On plain PostgreSQL run this file first, then wacrm_schema.sql. These stubs
-- are only enough to CREATE the schema; they do not provide sign-in, JWTs or
-- file storage. Row Level Security reads the signed-in user from the setting
--   request.jwt.claim.sub   (set it per connection:  SET request.jwt.claim.sub = '<uuid>')
-- Requires pgvector for ai_knowledge_chunks.embedding.
-- ============================================================================
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text,
  encrypted_password  text,
  raw_user_meta_data  jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz DEFAULT now(),
  last_sign_in_at     timestamptz
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id), name text, owner uuid
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT string_to_array(name, '/') $$;

DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;

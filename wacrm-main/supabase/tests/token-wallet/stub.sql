-- Minimal Supabase stand-in for testing migration 045 on plain
-- PostgreSQL (no Supabase CLI / Docker on the dev machine). Creates just
-- what 045 references: auth.users, accounts, update_updated_at_column.
-- Used only by src/lib/wallet/db.test.ts against a throwaway database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Optional platform roles (migration 043) so 046's platform-owner
-- exemption can be tested.
CREATE TABLE IF NOT EXISTS platform_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  platform_role text NOT NULL DEFAULT 'subscriber'
);

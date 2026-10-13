#!/usr/bin/env python3
"""Rebuild supabase/schema.sql from every file in supabase/migrations/.

Run from wacrm-main/:  python3 supabase/build_schema.py
The migrations stay the source of truth; schema.sql is a convenience copy
for pasting into a hosted project's SQL editor.
"""
import datetime
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")
OUT = os.path.join(HERE, "schema.sql")

files = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
header = f"""-- ============================================================
-- WhatsApp CRM — COMPLETE DATABASE SCHEMA
--
-- All {len(files)} migrations in supabase/migrations/, combined in order
-- ({files[0]} … {files[-1]}). Generated {datetime.date.today().isoformat()}
-- by supabase/build_schema.py — do not edit by hand.
--
-- How to use
--   Supabase dashboard → SQL Editor → New query → paste this whole file
--   → Run. Use the CRM's project (ref wluborxogujhpmiihtoq).
--
--   Every migration is written to be re-runnable (IF NOT EXISTS,
--   CREATE OR REPLACE, ON CONFLICT DO NOTHING), so this file works on a
--   brand-new project and on one that already has some of it applied.
--
-- Requires a Supabase project (auth and storage schemas, the
-- anon / authenticated / service_role roles, the pgvector extension).
--
-- NOTE: includes the token wallet (045 + 046). Every tenant account
-- starts at 0 tokens, so its automated sends stop until tokens are
-- added in Wallet → Adjust Wallet. The super admin's own account is
-- unlimited. Manual replies always work.
-- ============================================================
"""
parts = [header]
for f in files:
    with open(os.path.join(MIGRATIONS, f)) as fh:
        body = fh.read().rstrip()
    parts.append(
        f"\n\n-- ############################################################\n"
        f"-- ### {f}\n"
        f"-- ############################################################\n\n{body}\n"
    )
with open(OUT, "w") as fh:
    fh.write("".join(parts))
print(f"wrote {OUT} from {len(files)} migrations")

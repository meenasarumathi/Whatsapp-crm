# Runs on PostgreSQL instead of Supabase

The app now talks to a plain PostgreSQL database and no longer depends on Supabase for data, sign-in or file storage.

## What changed

- Data lives in PostgreSQL 16 (Docker: `docker compose up -d postgres`, port 5433, database `wacrm`).
- Sign-in is built in: email and password, kept signed in with a secure cookie. Sign-up signs you in straight away (no confirmation email).
- Password reset sends a link by email when SMTP is configured; otherwise the link is written to the server log.
- Changing your email in Profile takes effect immediately.
- Uploaded files (avatars, chat media, flow media) are stored on the server disk.
- Existing users keep their passwords when migrated from Supabase.

## Who it affects

- Roles: Owner / Admin / Agent / Viewer (everyone signs in again once after the switch)
- Tabs: Login, Sign up, Forgot / Reset password, Settings → Profile

## How to use it

1. Start the database: `docker compose up -d postgres` (the schema is applied on first start).
2. Set `AUTH_SECRET` (and optionally `SMTP_*`) in `.env.local`.
3. Moving existing data from Supabase: follow `migration/README.md` (export, import, validate).

## Related guide chapters updated

- 11 Settings
- 14 Train AI

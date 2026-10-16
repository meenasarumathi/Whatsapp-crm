# Migrating from Supabase to PostgreSQL

Moves an existing wacrm installation (database rows, auth users with their
password hashes, and uploaded files) from Supabase into the Docker PostgreSQL
database. Run the export **on your own computer**: it needs to reach your
Supabase project.

## What you get

`export.mjs` reads Supabase through one read-only, consistent snapshot and writes `OUT_DIR` (default `./export`):

| File | Purpose |
|---|---|
| `wacrm_data.xlsx` | Every table on its own sheet, plus `Index`, `Relationships` and `storage_objects`. For review. **Contains personal data; secrets are masked unless `--include-secrets-in-excel`.** |
| `wacrm_data.sql` | PostgreSQL `INSERT`s in foreign-key order, with primary keys, foreign keys and timestamps preserved. |
| `wacrm_embeddings.sql` | AI knowledge-base vectors (only needed with pgvector; skip with `--no-embeddings`). |
| `uploads/` | Files from the Supabase Storage buckets. |
| `manifest.json` | Row counts and checksums used by validation. |

Supabase `auth.users` become rows in `users` (bcrypt hashes are kept, so everyone keeps their password).
Storage URLs are rewritten to `/api/files/<bucket>/<path>`.

## Steps

1. Get the **Session pooler** connection string from Supabase → Project Settings → Database.
2. Export:
   ```bash
   cd migration && npm install
   SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
   SUPABASE_URL='https://<ref>.supabase.co' \
   NEW_SITE_URL='https://your-domain' \
   node export.mjs
   ```
   (`SUPABASE_URL` is needed to download storage files; without it use `--skip-files`.)
3. Start PostgreSQL and create the schema (skip the first command if a container already runs on port 5433):
   ```bash
   docker compose up -d postgres
   npm run db:init
   ```
4. Import (the container user `postgres` is a superuser, which the loader needs to defer foreign-key checks):
   ```bash
   npm run db:import -- migration/export/wacrm_data.sql
   # optional: npm run db:import -- migration/export/wacrm_embeddings.sql
   ```
5. Copy the files into the app's upload volume:
   ```bash
   docker cp migration/export/uploads/. <app-container>:/data/uploads/
   ```
   For `npm run dev`, copy them into the directory set as `UPLOAD_DIR` instead.
6. Validate **before anyone signs in** (a login updates `last_sign_in_at`, which changes the `users` checksum):
   ```bash
   DATABASE_URL=postgres://postgres:strong_password@localhost:5433/wacrm \
   node migration/validate.mjs --manifest migration/export/manifest.json --uploads migration/export/uploads
   ```
   It checks row counts, order-independent checksums, foreign-key orphans, constraint validity, that every user has a profile and password hash, and that every referenced file exists. A reported missing file is a real gap in the source storage.
7. Start the app and sign in with an existing account.

## After the move

- Keep `wacrm_data.xlsx` and `uploads/` private, then delete them when finished.
- Rotate the old Supabase keys (older versions of `.env.local.example` contained live keys) and pause the Supabase project once you are happy.
- Webhooks from Meta must reach a public `NEXT_PUBLIC_SITE_URL`; Meta fetches media from `/api/files/...`.

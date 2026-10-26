# Release — 2026-10-25: Token wallet on PostgreSQL

This release moves the token wallet (2026-10-11) and Wallet Management (2026-10-13) onto the PostgreSQL version of the CRM. The behaviour is unchanged.

Branch: `update/2026-10-25-wallet-admin-postgres`

## What changed

| Area | Change |
| --- | --- |
| Database | Migrations 045 + 046 merged into `wacrm-main/db/schema.sql` section 11 (re-runnable). `auth.users` → `users`. Tables and functions are closed to `wacrm_app`; only the owner connection uses them. |
| Server code | Wallet uses `createServiceDb()` from `@/lib/db` instead of a Supabase service-role client. |
| Payment proofs | Stored under `<UPLOAD_DIR>/private/recharge-proofs/`, outside the public `/api/files` buckets. `GET /api/wallet/admin/proof/[id]?download=1` serves the file after the permission check. |
| `token_submit_recharge` | Returns `SETOF recharge_requests`, so the RPC client gets a plain row. |
| Tests | `src/lib/wallet/db.test.ts` builds `db/schema.sql` on a throwaway database. |

## Apply

1. `cd wacrm-main && npm run db:init`
2. Wallet → grant tokens to the accounts that should keep automating (every account starts at 0).

## Roll back

There is no down-migration in the schema-file model. To remove the wallet, drop the section 11 tables and functions by hand after taking a backup.

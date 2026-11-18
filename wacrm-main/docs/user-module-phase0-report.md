# User Management module: Phase 0 report

13 Nov 2026. Inspection and plan only; no feature code. Decisions are in
[user-module-assumptions.md](user-module-assumptions.md).

Inputs used:

- `~/Desktop/crm_user_module.sql`, the schema draft.
- The requirements listed in the Phase 0 brief.

The "full User Management specification" was not found. The only spec files on disk (`~/Downloads/01_database_spec.json`, `02_backend_spec.json`, `03_frontend_spec.json`) describe an unrelated SEO agent. Anything the full spec says beyond the brief is not reflected here.

## 1. Existing stack and structure

| Area | What is there |
|---|---|
| Frontend | Next.js 16.3 (App Router, `src/app`) and React 19.2, Tailwind 4, shadcn/base-ui, lucide icons, next-intl (`messages/`) |
| Backend | Next.js Route Handlers under `src/app/api/**`, plus `src/middleware.ts` |
| ORM | None. Raw SQL through `pg` (`src/lib/db/pool.ts`) and a small query builder (`src/lib/db/builder.ts`) |
| Database | PostgreSQL 15+ (Docker image `pgvector/pgvector:pg16`, port 5433). Multi-tenant through `account_id`, RLS through `SET LOCAL ROLE wacrm_app` and `app.user_id` |
| Migrations | No up/down tool. One idempotent declarative file, `db/schema.sql`, applied by `npm run db:init`, which checks the live catalog against `db/schema-reference.json` in one transaction and records a checksum in `schema_migrations` |
| Auth | Custom. bcryptjs password hashes in `public.users`, HS256 JWT cookie (`jose`, `src/lib/auth/session-token.ts`) carrying `session_version`. Bumping it signs out every device. No per-session rows, no MFA, no login-attempt log. Password reset tokens exist (`password_reset_tokens`, SHA-256) |
| Roles | `profiles.account_role` (owner/admin/agent/viewer, inside a workspace) and `platform_users.platform_role` (super_admin/admin1/admin2/subscriber, platform-wide) with `subscription_status` and per-user `allowed_tabs` |
| Tests | Vitest 4 (`src/**/*.test.ts`), plus Postgres-gated tests (`TOKEN_WALLET_TEST_PG=1`) and e2e scripts in `scripts/e2e` |

Existing objects the module must reuse instead of duplicating:

| Object | What it already does |
|---|---|
| `users` | identity, password hash, session_version, last_sign_in_at |
| `profiles` | name, account and account role |
| `platform_users` | platform role, subscription status, trial, allowed tabs |
| `password_reset_tokens` | one-time reset links |
| `db_maintenance_log` | super-admin maintenance audit |
| `token_ledger` | per-account token money ledger. It is append-only, but deletes cascade from the account |
| Existing UI | Settings → Subscription users (`subscription-users-panel.tsx`), Security (`security-panel.tsx`, `sessions-card.tsx`) |
| Existing APIs | `/api/platform/users` (GET/POST/PATCH), `/api/auth/*` (login, logout, signup, forgot/reset/change password, change email, me, auto-login) |

No existing table covers sessions, login attempts, MFA, user audit events, access grants with reasons, revenue attribution or per-user commission.

## 2. Current test results

```
$ npx vitest run
 Test Files  107 passed | 3 skipped (110)
      Tests  1244 passed | 43 skipped (1287)
   Duration  2.09s
$ npx tsc --noEmit        → no errors
```

The 3 skipped files are Postgres-gated (`src/lib/db/embeds.test.ts`, `src/lib/db/builder.test.ts`, `src/lib/wallet/db.test.ts`). They need an environment flag and were not run.

Pre-existing problems found:

1. **`npm run db:init` fails on an empty database.** It tries to add `pipeline_stages_sla_hours_check` before the `sla_hours` column exists, then rolls back. Loading `db/schema.sql` directly with `psql` works (0 errors). This matters for fresh installs and CI.
2. **A real `META_APP_SECRET` is staged in `.env.local.example`.** The value `a07937f6…` replaces the placeholder. It must not be committed.

## 3. Schema draft: mismatches and errors

**Hard error: the draft does not apply.** Line 91 builds an index on `date_trunc('month', occurred_at)`, but that function is not immutable on `timestamptz`, so PostgreSQL rejects it: `ERROR: functions in index expression must be marked IMMUTABLE`. Nothing after line 91 runs.

| # | Draft | Problem | Fixed in v2 |
|---|---|---|---|
| 1 | `crm_users` table | Duplicates `users`, `profiles` and `platform_users`: a second password hash, email and role system | Extends `users` with `crm_user_profiles` (lifecycle, job role) and `crm_user_auth_security` (MFA, lockout, temp password) |
| 2 | `crm_login_sessions` | Attempts and sessions in one table, so a failed attempt looks like a session | Separate `crm_auth_login_attempts` (append-only) and `crm_auth_sessions` |
| 3 | `ON DELETE CASCADE` on grants and events; `SET NULL` on sessions | Deleting a user would erase their history | Every history FK is RESTRICT, checked by a test |
| 4 | Event types | Nothing for MFA, password reset, temp password, lockout, session revocation, exports, ledger, revenue, analyst views, bulk import, rejoin, platform-role vs job-role | 40 event types |
| 5 | Event `reason` | Comment says mandatory, but it is not enforced | CHECK requires a reason for role, access, lifecycle, admin MFA reset, unlock, revoke-all, adjustment, reversal and cancel |
| 6 | Revenue attribution | No payment status, refund, partial refund or cancellation | `payment_status`, `refunded_paise`, `refunded_at`, `cancelled_at`, `cancel_reason`, plus a CHECK that keeps them consistent; refunds can only grow; cancel is final |
| 7 | `share_pct numeric` | Fractional percent leads to fractional paise in views; shares per payment can exceed 100% | Integer `share_bp`, stored `attributed_paise`, and a trigger that caps the total at 100% and at the gross amount |
| 8 | `learner_payment_id uuid` | Points at a Razorpay or learner table that does not exist here | `payment_provider` + `payment_ref` + `gross_amount_paise` (decision 10) |
| 9 | Ledger | No `reversal_of`, so a reversal can't name what it reverses | `reversal_of` (unique, RESTRICT), with a trigger: same user, exact opposite amount, never reverse a reversal |
| 10 | Ledger | No sign rules; no required reason; `created_by` nullable | Sign CHECK per type, reason required for adjustment and reversal, `created_by NOT NULL` |
| 11 | Append-only | Trigger only on events; ledger and login attempts can be edited; TRUNCATE allowed | Row and TRUNCATE triggers on events, ledger and login attempts; guarded updates on grants, sessions and revenue |
| 12 | Grants | No exclusion constraint, so overlapping grants for one user and module are possible | `EXCLUDE USING gist (user_id =, module =, effective period &&)` with btree_gist |
| 13 | Grants | Any column editable (level, expiry, reason) | Only the revoke fields, once. Changes are new grants (`replaces_grant_id`) |
| 14 | Grants | Revoke reason not required; `access_level 'none'` is meaningless as a grant | Revoke needs by, at and reason together; levels are read, write and manage |
| 15 | Monthly views | `date_trunc` in the database time zone. 31 Oct 19:00 UTC (1 Nov IST) lands in October | `crm_ist_month()` in Asia/Kolkata, indexed; a test covers the boundary |
| 16 | Movement view | Unclear counting; text aggregation of reasons | Defined columns: joined, rejoined, left, suspended, reinstated, disabled, grant events vs distinct users, access ended |
| 17 | Analyst view | Includes balance, which admins must not see | Admin view has no balance; balance has its own view |
| 18 | Revenue view | Counts refunded and cancelled payments as full revenue | Net of refunds; cancelled = 0 |
| 19 | Missing tables | Recovery codes, notification delivery, background jobs, bulk import | `crm_mfa_recovery_codes`, `crm_notification_deliveries`, `crm_jobs`, `crm_user_imports` + `crm_user_import_rows`. Reset tokens reuse the existing table |
| 20 | Last Super Admin | Not protected | Trigger on `platform_users` and `crm_user_profiles` blocks demoting, suspending, deleting or deactivating the last active Super Admin. It is serialised with an advisory lock so concurrent changes cannot both pass |
| 21 | New enum types | `CREATE TYPE` fails on re-run and `db:init` never drops enums | text + CHECK (project convention) |
| 22 | Access control | No RLS; views would bypass RLS | RLS on with no policies (server only); views use `security_invoker`, tested as `wacrm_app` |
| 23 | Users | No temp-password expiry, no forced password change | `must_change_password`, `temp_password_expires_at` |

## 4. Schema v2 files

| File | Purpose |
|---|---|
| `db/user-module/0001_user_module_v2.up.sql` | Up migration. Idempotent: applying it twice is safe |
| `db/user-module/0001_user_module_v2.down.sql` | Down migration. Refuses to run while history rows exist unless `crm.allow_destructive_down = 'on'` |
| `db/user-module/0001_user_module_v2.test.sql` | 55 checks, run in a transaction that rolls back |

Applied only to a throwaway local cluster: PostgreSQL 18.4, 127.0.0.1:55432, created in the session scratchpad. It was not applied to your dev database (`DATABASE_URL`) or anything shared. Results:

- up: OK; up again: OK.
- tests: 55/55 PASS.
- Re-running the existing `db/schema.sql` on top of v2: 0 errors.
- down with history present: refused.
- down with override: OK. It leaves 0 `crm_*` objects and restores the original `password_reset_tokens` columns.
- up again, then tests: 55/55 PASS.

Changes to existing objects (additive only): two nullable columns on `password_reset_tokens` (`issued_by`, `requested_ip`) and one trigger on `platform_users`.

v2 is not in `db/schema.sql` yet. Folding it in is the first task of Phase 1. That also means regenerating `db/schema-reference.json`, which must be done without the old file, and fixing the `db:init` empty-database bug.

## 5. Phase plan

Each phase ships with:

- the vitest suite and `tsc` green;
- the SQL test file green on a fresh local database;
- a `Guide/updates/<date>-<name>/` entry and the matching chapter update.

### Phase 1: Authentication, sessions, MFA, password reset (about 4 sessions)

**Scope:**

- Fold v2 into `schema.sql` and fix `db:init` on empty databases.
- Per-session rows: the JWT carries `sid`, and the middleware checks the session is open.
- Login-attempt logging.
- Lockout.
- TOTP MFA enrol, verify and disable, plus recovery codes.
- Admin-issued temporary password (72h) with forced change.
- Reset requests logged with IP.
- Revoke one session or all sessions, from Security → Sessions.

**Excluded:** SSO, WebAuthn, SMS OTP.

**Touches:**

- `src/lib/auth/session-token.ts`, `session.ts`, `password.ts`, new `src/lib/auth/mfa.ts`.
- `src/app/api/auth/{login,logout,reset-password,change-password}`, new `src/app/api/auth/{mfa,sessions}`.
- `src/middleware.ts`.
- `sessions-card.tsx`, `security-panel.tsx`.
- Tables: `crm_auth_sessions`, `crm_auth_login_attempts`, `crm_user_auth_security`, `crm_mfa_recovery_codes`, `password_reset_tokens`, `crm_user_events`.

**Acceptance:**

- A wrong password writes an attempt with no session.
- The 6th failure within the window returns "locked" and writes `account_locked`.
- A revoked session's cookie is rejected on the next request.
- "Sign out everywhere" ends every open session and writes `all_sessions_revoked` with a reason.
- An MFA user without a code gets `mfa_required` and no session.
- A recovery code works once.
- An expired temporary password is refused.
- Existing users' cookies keep working through the migration, or are forced to sign in once (decide which).
- The auto-login bypass still works on localhost only.

### Phase 2: User management and lifecycle (about 3 sessions)

**Scope:**

- Create, edit, suspend, reinstate, disable, leave and rejoin users, with mandatory reasons.
- Job role and department.
- Platform role changes, Super Admin only.
- Last Super Admin protection surfaced in the UI.
- Suspend, disable and leave end all sessions.

**Excluded:** deleting users (blocked by design).

**Touches:**

- `src/app/api/platform/users`, `src/lib/platform/access.ts`, `subscription-users-panel.tsx`.
- Tables: `crm_user_profiles`, `platform_users`, `crm_user_events`.

**Acceptance:**

- Every lifecycle change writes exactly one event with actor and reason.
- A suspended user's open session is rejected.
- The API returns 409 with a clear message when demoting the last Super Admin.
- Admin1 and Admin2 cannot change platform roles.
- A user with history cannot be deleted.

### Phase 3: Access grants and expiry enforcement (about 3 sessions)

**Scope:**

- Grant, revoke and renew per module with reason and expiry.
- Migrate `allowed_tabs` to open-ended grants.
- `access-guard.tsx` and the sidebar read live grants.
- An expiry job revokes or marks `access_expired`.

**Excluded:** reminders (Phase 6).

**Touches:**

- `src/lib/platform/*`, `src/components/layout/{access-guard,sidebar}.tsx`.
- Tables: `crm_access_grants`, `crm_jobs`, `crm_user_events`.

**Acceptance:**

- An overlapping grant returns 409.
- An expired grant hides the tab within 1 minute and the API returns 403.
- Migration preserves every user's current tabs.
- A level change creates a new grant linked by `replaces_grant_id`.
- The open-ended review list is correct.

### Phase 4: Ledger and revenue attribution (about 4 sessions)

**Scope:**

- Record payments (source per decision 10).
- Attribution with the rounding rule.
- Refunds, partial refunds and cancellations.
- Commission and payout entries.
- Reversals.

**Excluded:** automatic commission rules, unless decision 1 asks for them; payout banking.

**Touches:**

- New `src/lib/user-module/{revenue,ledger}.ts`, new API routes.
- Tables: `crm_revenue_attributions`, `crm_user_ledger`, `crm_user_events`.

**Acceptance:**

- A 3-way split of ₹10,000.01 sums to exactly 1,000,001 paise.
- A partial refund leaves the correct net.
- Shares over 100% are rejected.
- A reversal requires the exact opposite amount.
- The balance equals the sum of entries.
- Every ledger write has an event.
- No endpoint can UPDATE or DELETE ledger rows.

### Phase 5: Analyst tab and monthly movement report (about 2 sessions)

**Scope:**

- Analyst tab: admins see access and revenue; the Super Admin also sees balances.
- Monthly movement report in IST.
- View events logged.

**Excluded:** exports (Phase 6).

**Touches:**

- New page and API.
- Views: `crm_user_analyst`, `crm_user_monthly_revenue`, `crm_monthly_user_movement`, `crm_user_balance`.

**Acceptance:**

- An Admin's API response contains no balance field. The Super Admin's does.
- An event at 23:45 IST on the last day of a month counts in that month.
- Same-month join and leave counts in both.
- Every page view writes `analyst_viewed`.

### Phase 6: Exports, expiry reminders, bulk import, background jobs (about 4 sessions)

**Scope:**

- Job runner on the existing built-in scheduler.
- CSV/XLSX exports (exceljs), each with an event.
- Grant expiry reminders, email and in-app, 7 days and 1 day before.
- Bulk user import with dry run.

**Excluded:** a third-party queue.

**Touches:**

- `src/instrumentation.ts` scheduler, `src/lib/auth/mailer.ts`.
- `notifications.type` CHECK widened (documented, additive).
- Tables: `crm_jobs`, `crm_notification_deliveries`, `crm_user_imports`, `crm_user_import_rows`.

**Acceptance:**

- Running the reminder job twice sends each reminder once.
- A failed email retries up to `max_attempts`.
- An import dry run creates no users and reports every bad row.
- A real import is all or nothing per row and writes `bulk_import_completed`.
- An export of 10,000 events finishes as a job and writes `export_requested` and `export_downloaded`.

**Total:** about 20 working sessions.

## 6. Questions to answer before Phase 1

1. **Who is the module for?** The platform operator's own staff, or each subscription workspace's team (decision 9)? This decides the whole data scope.
2. **Where is the full spec?** Please attach it. Only the brief and the SQL draft were available.
3. **Sessions migration:** keep existing cookies working, or force one sign-in for everyone when per-session rows go live?
4. **MFA and lockout policy (decision 14):** who must use MFA, how many attempts before lockout, and for how long?
5. **Roles (decision 11):** do admin1 and admin2 both count as "Admin", and are the spec's roles job labels rather than permissions?
6. **Confirm or change decisions 1, 2, 3, 5, 6, 7 and 8** in `user-module-assumptions.md`. They do not block Phase 1, but they block Phases 4 to 6.
7. **Revenue source (decision 10):** manual entry, Razorpay webhook, or another system. This blocks Phase 4.
8. **`META_APP_SECRET` in `.env.local.example`:** may I reset the staged file to the placeholder?

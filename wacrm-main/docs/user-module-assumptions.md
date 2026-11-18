# User Management module: decisions and assumptions

Status: Phase 0, 13 Nov 2026. Updated after the owner's Phase 1 answers (13 Nov 2026). Each decision is marked:

- **Confirmed by owner**: stated in the owner's spec or brief.
- **Assumed, to confirm**: my default. Schema v2 supports it, and changing it later costs little unless noted.

Schema v2 lives in `db/user-module/0001_user_module_v2.up.sql` (down and test files are next to it).

## The eight requested decisions

### 1. What "balance" means
**Partly confirmed by owner** (13 Nov 2026). Balance = sum of the user's ledger entries (`crm_user_ledger.amount_paise`): payouts (−), manual adjustments (±) and reversals. Commission: to be decided later; until then no commission entries are posted.

Owner rule B (acceptance test): a payout may not take the balance below zero unless it is explicitly overridden (`allow_overdraw` plus a reason). Owner rule C: every entry has a unique `idempotency_key`, so a retried request can never post twice.

### 2. Revenue attribution rule
**Changed by owner** (13 Nov 2026, rule D). Payments are recorded in `crm_revenue_payments` (manual entry or CSV import) and divided between users in `crm_revenue_splits`. When a payment has splits, they must total exactly 100% (10000 bp) and exactly the payment amount, checked when the change is saved. A payment reference can only be used once (case and spaces ignored). Default still to confirm: the closer gets 100% unless an admin splits it. `crm_revenue_attributions` from v2 is superseded and not written by the app.

### 3. Refunds and cancellations in revenue reports
**Confirmed by owner** (13 Nov 2026): refunds reduce the payment's month.

- A refund reduces net revenue in the IST month the payment was made, so past months are restated. It does not appear as a negative figure in the refund month.
- A cancelled attribution (chargeback, payment voided) counts as zero.
- Commission already posted is not reversed automatically. Finance posts a reversal or adjustment with a reason.

Alternative: book refunds in the month they happen, which keeps closed months frozen. This changes only the report view, not the tables.

### 4. Can admins see other users' revenue and balances?
**Confirmed by owner (per spec).** Admins can see other users' revenue. Only the Super Admin can see balances. In v2 the admin analyst view (`crm_user_analyst`) has no balance column, and balances are only in `crm_user_balance`, which only Super Admin endpoints will query. Viewing a balance writes a `balance_viewed` event.

### 5. Monthly report counting rules
**Assumed, to confirm.** Months are calendar months in Asia/Kolkata.

| Situation | Counted as |
|---|---|
| Joins and leaves in the same month | 1 in "joined" and 1 in "left" |
| Leaves, then comes back | "rejoined", not "joined" |
| Suspended, then reinstated | "suspended" and "reinstated" columns, never joined or left |
| Granted the same module twice in a month | 2 grant events, 1 user granted (both columns are shown) |
| Grant ends by expiry or by revoke | Both count as "access ended" (events and distinct users) |

### 6. Rounding of attribution shares
**Assumed, to confirm.** Each share is floor(gross × share_bp / 10000) paise. Leftover paise go to the largest share. On a tie they go to the closer, then to the earliest row. When shares total 100%, the shares add up exactly to the gross amount. Refunds are split with the same rule.

The app computes this and stores the result in `attributed_paise`. The database stores whole paise only and never rounds.

### 7. Temporary password expiry
**Confirmed by owner** (default kept, 13 Nov 2026). 72 hours. The user must change it at first sign-in (`must_change_password`). An expired temporary password is rejected and the login attempt is logged as `temp_password_expired`.

### 8. Channel for expiry reminders
**Assumed, to confirm.** Both email (the existing SMTP mailer) and in-app, sent 7 days and 1 day before a grant expires. Each send is recorded once per grant, reminder and channel (`crm_notification_deliveries.dedupe_key`), so retries never double-send.

In-app reminders need one new value (`access_expiry`) in the CHECK on the existing `notifications.type` column. That is a documented, additive change for Phase 6, not part of v2.

## Further decisions found during inspection

### 9. Who are the "users"?
**Confirmed by owner** (13 Nov 2026). The module is for platform-level staff and administrators (people with a `platform_users` row managed by the Super Admin), not for individual subscription workspaces. Workspace and team user management is handled separately.

Sign-in security (sessions, lockout, MFA, temporary passwords) applies to everyone who signs in, because there is one login for the whole CRM. MFA is mandatory only for the admin roles (decision 14).

### 10. Where revenue comes from
**Confirmed by owner** (13 Nov 2026): manual entry and CSV import (for example a Razorpay export). No Razorpay connection for now; a webhook can be added later.

### 11. Roles: one system or two?
**Partly confirmed by owner** (13 Nov 2026): admin1 and admin2 keep their identifiers and both have the Admin permission level (`permissionLevel()` in `src/lib/auth/security-policy.ts`). Still to confirm: the spec's role list as `job_role` labels. Permission roles stay in the existing `platform_users.platform_role` (super_admin, admin1, admin2, subscriber). The spec's role list becomes `job_role`, a team label used in reports, not a permission. Module access comes from `crm_access_grants`.

To confirm: should admin1 and admin2 both count as "Admin" in the spec?

### 12. Module names for grants
**Assumed, to confirm.** Grant modules are free-text keys checked by format. The app will accept only the existing sidebar tab keys (`ALL_TAB_KEYS` in `src/lib/platform/access.ts`). Today's `allowed_tabs` would then be replaced by grants that carry a reason and an expiry, migrated as open-ended grants with the reason "migrated from allowed_tabs".

### 13. Password hashing
**Assumed, to confirm.** Keep bcrypt, which existing users already have. A switch to argon2id would rehash each user at their next login.

### 14. Lockout and MFA policy
**Confirmed by owner** (13 Nov 2026), implemented in Phase 1:

- 5 consecutive failed attempts (wrong password or wrong MFA code) lock the account for 15 minutes.
- MFA (TOTP) is mandatory for Super Admin and Admin (admin1, admin2), optional for others. Mandatory users cannot turn it off.
- 10 single-use recovery codes.
- Sessions expire after 7 days, and after 30 minutes idle for Super Admin.
- Every user signs in once more when per-session tracking goes live.

Correction to the Phase 0 text: the old cookie lasted 30 days, not 7, so the 7-day session is a shortening, not "the same as today".

### 15. Open-ended grants
**Changed by owner** (13 Nov 2026, rule A). A grant without an expiry date must have a review date (`review_due_at`). The review date can be moved when a review is done; nothing else on a grant can change except revoking it.

### 16. The `no_access` role
**Confirmed by owner** (13 Nov 2026). No new role: a staff user who holds no access grants simply sees no modules.

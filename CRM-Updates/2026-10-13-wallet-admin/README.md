# Release — 2026-10-13: Wallet management for the platform owner

This release gives the platform owner one screen to see every company's wallet and credit or debit it in rupees, and makes the owner's own account unlimited.

Branch: `update/2026-10-13-wallet-admin`

## What's new

| Area | Change |
| --- | --- |
| Billing | Super admin's own account is unlimited — automated sends never charged (migration 046) |
| Wallet page | Wallet Management for platform admins: owner banner, stats, tenant table with ₹ balance and total spent |
| Adjust Wallet | Credit / Debit in ₹ with quick amounts and a required reason; converted to tokens at the current rate inside the database |
| Performance | Per-account usage counted in SQL (`token_usage_summary`), not by loading every charge |
| Light theme | Wallet colours readable in light mode |

## Apply

1. Supabase SQL editor (project `wluborxogujhpmiihtoq`): run `043`, `044`, `045` if not already done, then `wacrm-main/supabase/migrations/046_wallet_platform_owner.sql`.
2. Open **Wallet** as the Super admin.

Roll back: `wacrm-main/supabase/rollbacks/046_wallet_platform_owner.down.sql` (keeps all ledger data).

## Not included (owner decision needed)

- **Razorpay online recharge** appears in the reference screenshot. The agreed rule (D7) is manual GPay only with no payment gateway, so it was not added.

## Positioning against Zoho's WhatsApp CRM

Zoho's pricing and features weren't checked for this release, so the table below states what this CRM now does, as the points to compare in a sales conversation. Verify Zoho's current offer before using any side-by-side claim.

| What customers compare | This CRM after this release |
| --- | --- |
| Cost visibility | One simple meter: 0.5 token per automated message, shown live in ₹ per company |
| Agent replies | Always free on our meter, even at zero balance — teams are never locked out of their own customers (Meta's own WhatsApp charges still apply) |
| Failed sends | Refunded automatically when WhatsApp rejects a message; uncertain sends held for review, never double-sent |
| Running out | Red ₹0 badge per company, "automations paused" banner, recharge in one form |
| Reseller / agency use | Platform owner view: every tenant's balance, spend and manual adjustments with an audit trail |
| Trust | Append-only ledger, a reason required for every manual change, CSV reports |

Recommended next moves to widen the lead: low-balance WhatsApp/email alerts to tenants, auto-top-up via a payment gateway (once D7 is revisited), and a per-campaign cost estimate in the broadcast wizard before sending.

## Checks run (2026-10-13)

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run lint` | 0 errors; 0 warnings in the new wallet files (older files carry 39 existing warnings) |
| `npm test` | 1,155 passed, 17 skipped (database tests need Postgres) |
| `TOKEN_WALLET_TEST_PG=1 npm test` (local PostgreSQL 16) | 1,172 passed — includes 046 up / re-run / down, unlimited owner under parallel sends, ₹ adjust at a non-default rate |
| `npm run build` | exit 0 |

Not yet verified: running 046 on the hosted Supabase project, and the screen in a browser while signed in.

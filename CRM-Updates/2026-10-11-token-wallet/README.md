# Release — 2026-10-11: Token wallet and automated-message metering

Automated WhatsApp messages now cost 0.5 token each, from a per-account wallet that customers recharge by GPay and admins approve.

## What's new

| Area | Change |
| --- | --- |
| Billing | `token_wallets`, append-only `token_ledger`, `recharge_requests`, `message_charges`, `account_feature_flags`, `token_settings` (migration 045) |
| Automation, chatbot, AI agent, broadcast, API | Every automated send reserves 500 units before calling WhatsApp; confirm, refund or review afterwards |
| Inbox | Manual replies stay free and work at zero balance |
| UI | Token Wallet tab, dashboard balance tile, "automated replies paused" banner, Settings → Token admin |
| Ops | `GET /api/wallet/reconcile` cron escalates stuck charges to the review queue |

Full design, send-path table and decisions: [`wacrm-main/docs/token-wallet/PLAN.md`](../../wacrm-main/docs/token-wallet/PLAN.md).

## Apply

1. `cd wacrm-main && npm install`
2. Supabase SQL editor: run `wacrm-main/supabase/migrations/045_token_wallet.sql`.
   Every account starts at **0 tokens**, so automated sends stop until tokens are granted.
3. Settings → Token admin: set the UPI ID, then grant tokens to the accounts that should keep automating.
4. Optional cron: `GET /api/wallet/reconcile` with header `x-cron-secret: $AUTOMATION_CRON_SECRET`.

## Roll back

Run `wacrm-main/supabase/rollbacks/045_token_wallet.down.sql`. This deletes all wallet data, so take a backup first. The private `recharge-proofs` bucket is kept.

## Checks run (2026-10-11)

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run lint` | 0 errors, 39 warnings (all in files this release didn't create) |
| `npm test` | 1,146 passed, 14 skipped (DB tests need Postgres) |
| `TOKEN_WALLET_TEST_PG=1 npm test` (local PostgreSQL 16) | 1,160 passed |
| `npm run build` | exit 0 |

## Known limitation

If WhatsApp accepts a message but the reply is lost (timeout, dropped connection, 5xx), we can't tell whether it was sent. Meta's Cloud API has no endpoint to look an outgoing message up, and without the reply there is no message ID to match against status webhooks. Such charges stay reserved in **Token admin → Review** until the Super admin marks them sent or refunds them. They are never resent automatically.

## Follow-up (not in this release)

- Monthly subscriptions and invoicing (D10).
- Modelling Meta's own conversation pricing (D11 — tokens are an internal meter only).
- Enforcing feature switches and wallet blocks on the public API's other endpoints, and per-account low-balance email alerts.

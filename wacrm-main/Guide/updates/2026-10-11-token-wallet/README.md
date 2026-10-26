# Token Wallet: pay-per-message for automated replies

Automated WhatsApp messages now use tokens from a wallet. Replies you type yourself stay free.

## What changed

- Every message sent automatically costs **0.5 token**: AI replies, automations (including scheduled steps), chatbot flows, each broadcast recipient, and API sends.
- Replies an agent types in the Inbox are **free** and keep working even at zero balance.
- At zero balance, automated sends stop and every page shows: "Insufficient tokens. Automated replies are paused. Manual replies are still available."
- New sidebar tab **Token Wallet**: balance, GPay instructions, recharge form, request status, usage and full history.
- New dashboard tile with the current balance.
- New settings section **Token admin** (Platform) for the Super admin, Admin 1 and Admin 2: approval queue, accounts, grants and deductions, feature switches, review queue, reports with CSV export, and the rupee-to-token rate.
- Default rate: ₹1 = 1 token. Tokens never expire. Payments are manual (GPay) and are only credited when an admin approves them.

## Who it affects

- Roles: account owners (recharge, history), every member (sees the balance and the paused banner), Super admin (grant, deduct, rate, switches, review), Admin 1 and Admin 2 (approve recharges, reports).
- Tabs: Token Wallet, Dashboard, Settings → Token admin, Automations, Flows, AI Agents, Broadcasts.

## How to use it

> **Update 2026-10-25:** the wallet is now set up by `npm run db:init` (db/schema.sql). The SQL steps below are for the old Supabase version.

1. Run `supabase/migrations/045_token_wallet.sql` once in the Supabase SQL editor. Every account starts at **0 tokens**, so automated replies stop until tokens are added.
2. Super admin: open **Settings → Token admin → Rate & GPay** and enter your UPI ID.
3. Super admin: give your own account (and any trial customers) tokens under **Accounts → Grant**, with a reason.
4. Customers: open **Token Wallet**, pay with GPay, then submit the amount, UPI transaction ID and screenshot.
5. Admins: open **Token admin → Recharges**, check the money arrived in GPay, then **Approve & credit** (or **Reject** with a note).
6. Optional: call `GET /api/wallet/reconcile` from your cron with the `x-cron-secret` header every few minutes.

To undo: run `supabase/rollbacks/045_token_wallet.down.sql`. This deletes all wallet data, so take a backup first.

## Related guide chapters updated

- New chapter: Token Wallet
- Settings → Token admin
- Getting started → The screen layout

# Token wallet

Every automated WhatsApp message costs 0.5 token (500 units) from the account's wallet; manual inbox replies are free.

| Work | What it does | Where |
| --- | --- | --- |
| Wallet and ledger | Integer units (1 token = 1000 units), append-only ledger, balance can't go negative | Migration 045 |
| Charging lifecycle | Feature switch → reserve 500 (wallet row locked) → send → confirm, refund (4xx) or review (timeout / 5xx) | `src/lib/wallet/charge.ts` |
| Charged paths | AI auto-reply, automations (incl. scheduled), chatbot flows, broadcast recipients, public API sends | `src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts`, `src/lib/whatsapp/broadcast-core.ts`, `src/app/api/whatsapp/broadcast/route.ts`, `src/lib/whatsapp/send-message.ts` |
| Free paths | Agent replies in the inbox, reactions, typing indicator | — |
| Feature switches | Chatbot, workflow, AI agent on or off per account | Settings → Token admin → Accounts |
| Recharge | Customer submits amount, UPI ID and proof (private bucket); admin approves (idempotent) or rejects with a note | Token Wallet page; Token admin → Recharges |
| Grants / deductions | Super admin, with a required reason | Token admin → Accounts |
| Rate | Tokens per rupee as a fraction (default 1/1), stored on every request and grant | Token admin → Rate & GPay |
| Reports | Ledger filtered by account, dates and type; CSV export | Token admin → Reports |
| Review queue | Ambiguous sends resolved by hand; reconciliation cron escalates stuck charges | Token admin → Review; `/api/wallet/reconcile` |

Roles: `super_admin` = platform Super admin; `admin` = Admin 1 / Admin 2; `customer` = account owner.

## Update history

| Date | Change |
| --- | --- |
| 2026-10-11 | Added — see [release notes](../2026-10-11-token-wallet/README.md). |
| 2026-10-13 | Wallet Management screen, unlimited platform owner, ₹ Adjust Wallet — see [release notes](../2026-10-13-wallet-admin/README.md). |

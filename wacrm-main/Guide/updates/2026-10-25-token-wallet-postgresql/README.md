# Token wallet now runs on PostgreSQL

The token wallet and Wallet Management screen work on the new PostgreSQL database, so they no longer need any Supabase setup.

## What changed

- The wallet tables and money functions are part of `db/schema.sql`, so `npm run db:init` sets them up. There are no separate SQL files to paste any more.
- Every account starts at **0 tokens**, so automated replies stop until tokens are added. The Super admin's own account is unlimited.
- GPay payment proofs are stored privately on the server disk. Only platform admins, and the owner of the account that sent a proof, can open it.

## Who it affects

- Roles: Owner (recharges), Super admin / Admin 1 / Admin 2 (Token admin and Wallet Management)
- Tabs: Wallet, Settings → Token admin

## How to use it

1. Run `npm run db:init`. It is safe to run again on an existing database.
2. Open **Wallet** as the Super admin and give tokens to the accounts that should keep automating.

## Related guide chapters updated

- 11 Settings

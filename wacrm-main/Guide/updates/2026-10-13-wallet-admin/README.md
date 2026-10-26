# Wallet management for the platform owner

The Wallet page now gives the Super admin one screen to see every company's balance and top it up or deduct in rupees.

## What changed

- The Super admin's own account is **Unlimited**: its automated messages are never charged and it never needs a recharge.
- **Wallet** (sidebar) for Super admin, Admin 1 and Admin 2 now opens **Wallet Management**:
  - a "Platform Owner Account (Unlimited Wallet)" banner (Super admin),
  - quick stats: total tenant balance, companies at ₹0, recharges waiting, automated messages in 30 days,
  - **Tenant Companies Wallet Ledger & Manual Adjustments**: company name, owner email, wallet balance and total spent in ₹, with search.
- **Adjust Wallet** (Super admin): Credit (+ Add) or Debit (- Deduct), quick amounts ₹100 / ₹500 / ₹1,000 / ₹2,500 / ₹5,000, any amount in ₹, and a reason. It shows the tokens and the balance after before you confirm. A debit can't take a balance below zero.
- Balances are colour-coded: red at ₹0 (automation paused), amber when low, green otherwise. Hover a balance to see it in tokens.
- Admin 1 and Admin 2 see the table read-only, and can switch to **My wallet** for their own company.
- The sidebar and top bar now say **Wallet**.

## Who it affects

- Roles: Super admin (adjust), Admin 1 and Admin 2 (view), customers (unchanged — they still see their own wallet).
- Tabs: Wallet, Dashboard.

## How to use it

> **Update 2026-10-25:** the wallet is now set up by `npm run db:init` (db/schema.sql). The SQL steps below are for the old Supabase version.

1. Run `supabase/migrations/046_wallet_platform_owner.sql` once in the Supabase SQL editor (after 043, 044 and 045).
2. Open **Wallet**.
3. Click **Adjust Wallet** on a company, choose Credit or Debit, pick or type an amount in ₹, keep or edit the reason, then click **Add Credit** (or **Deduct Amount**).

## Related guide chapters updated

- Token Wallet → For the platform owner and admins

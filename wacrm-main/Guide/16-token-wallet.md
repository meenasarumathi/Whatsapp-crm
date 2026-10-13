# Token Wallet

Automated WhatsApp messages are paid for with tokens; replies you type yourself are always free.

Open **Token Wallet** from the bottom of the sidebar (above Settings).

## What costs tokens

| Message | Cost |
| --- | --- |
| AI auto-reply | 0.5 token |
| Automation step (including scheduled steps after a wait) | 0.5 token |
| Chatbot flow message, buttons, list or media | 0.5 token |
| Each broadcast recipient | 0.5 token |
| Message sent through the API | 0.5 token |
| Reply typed by an agent in the Inbox | Free |
| Reactions | Free |

A message is only charged when WhatsApp accepts it. If WhatsApp rejects it (for example, an invalid number), the 0.5 token is refunded automatically. Tokens never expire.

## When the balance runs out

Automated replies pause, and every page shows "Insufficient tokens. Automated replies are paused. Manual replies are still available." Agents can keep replying by hand. Recharge to switch automation back on — no other setting needs changing.

## Recharging with GPay (account owner)

1. Pay with GPay to the UPI ID shown on the page.
2. Note the UPI transaction ID and take a screenshot.
3. In **Request a recharge**, enter the amount you paid, the transaction ID and the screenshot (PNG, JPG or PDF, up to 5 MB), then click **Submit recharge request**.
4. The request shows **Waiting for approval**. Tokens are added once an admin confirms the payment.

The page shows how many tokens you will get at today's rate before you submit. A request keeps the rate it was made at, even if the rate changes later.

## What the page shows

- **Token balance**, and how many automated messages it covers.
- **Your recharge requests**, with their status and any note from the admin.
- **Usage in the last 30 days** — messages by AI agent, chatbot, workflow, broadcast and API.
- **Transaction history** — every grant, recharge, message charge, refund and deduction, with the balance after each.

Only the account owner sees the full page. Other team members see the balance.

## For the platform owner and admins

The Super admin's own account is **Unlimited**: its automated messages are never charged.

For the Super admin, Admin 1 and Admin 2, **Wallet** opens **Wallet Management**:

- Quick stats — total tenant balance, companies at ₹0, recharges waiting, automated messages in the last 30 days.
- **Tenant Companies Wallet Ledger & Manual Adjustments** — every company's owner email, wallet balance and total spent in ₹ (at the current rate; hover for tokens). Red means ₹0 and automation is paused.
- **Adjust Wallet** (Super admin only) — Credit (+ Add) or Debit (- Deduct) in ₹, with quick amounts and a required reason. The dialog shows the tokens and the balance after. A debit can't go below zero.

Admin 1 and Admin 2 can switch between **Tenant wallets** and **My wallet**.

> **Tip:** The recharge approval queue, review queue, reports and rate are in **Settings → Token admin**. See the Settings chapter.

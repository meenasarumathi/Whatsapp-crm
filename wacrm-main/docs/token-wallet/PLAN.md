# Token wallet — Phase 1 inspection and plan

> **2026-10-25:** the CRM now runs on plain PostgreSQL. The wallet SQL (045 + 046) lives in `db/schema.sql` section 11, and server code uses `@/lib/db`. The Supabase notes below describe the original design.

Status: inspection complete, 2026-10-11. No stop condition applies (see §6).

## 1. Stack

| Item | Found |
| --- | --- |
| Framework | Next.js 16.3.5 (App Router, Turbopack), React 19, TypeScript 6 |
| Data layer | Supabase (Postgres) via `@supabase/supabase-js` / `@supabase/ssr`. No ORM. Server routes use the SSR client (RLS as the caller) or a service-role client (`supabaseAdmin()`). |
| Migrations | Supabase CLI style: forward-only SQL files in `supabase/migrations/NNN_name.sql`, applied by `supabase db reset` in CI (`.github/workflows/migrations.yml`) or pasted into the Supabase SQL editor. There is no down-migration convention, so rollbacks go in `supabase/rollbacks/` (the CLI never runs that folder). |
| Auth model | Supabase Auth. Account roles on `profiles.account_role` (owner / admin / agent / viewer, migration 017). Platform roles on `platform_users.platform_role` (super_admin / admin1 / admin2 / subscriber, migration 043). Server guards: `requireRole()` (`src/lib/auth/account.ts`), `getPlatformContext()` / `requirePlatformAdmin()` (`src/lib/platform/server.ts`). |
| Tests | Vitest 4 (`npm test` → `vitest run`, `src/**/*.test.ts`) |
| Lint / types / build | `npm run lint` (eslint), `npm run typecheck` (`tsc --noEmit`), `npm run build` (`next build`) — the same four commands as `.github/workflows/ci.yml` |
| Database for tests | No Supabase CLI or Docker. A local PostgreSQL 16 server is running at `/tmp:5432`. DB tests create a throwaway database `wacrm_token_wallet_test` with a minimal Supabase stub (`auth.users`, `auth.uid()`, `auth.role()`, `accounts`, `profiles`) and drop it afterwards. They run only when `TOKEN_WALLET_TEST_PG=1`. |

## 2. Every outgoing WhatsApp send path

Provider client: `src/lib/whatsapp/meta-api.ts` (`sendTextMessage`, `sendMediaMessage`, `sendTemplateMessage`, `sendInteractiveButtons`, `sendInteractiveList`, `sendReactionMessage`, `sendTypingIndicator`). Errors are thrown as `MetaApiError` with `httpStatus`; network failures are plain `TypeError`s.

| # | Path | File | Trigger | Automated / manual | Current send function | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Inbox agent reply (text, media, template, interactive) | `src/app/api/whatsapp/send/route.ts` → `src/lib/whatsapp/send-message.ts` `sendMessageToConversation` | Agent clicks Send | Manual | `sendText/Media/Template/InteractiveButtons/InteractiveList` | **Exempt** (D2). Allowed at zero balance. |
| 2 | Reaction | `src/app/api/whatsapp/react/route.ts` | Agent reacts | Manual | `sendReactionMessage` | **Exempt** (manual) |
| 3 | Typing indicator / mark read | `src/lib/ai/auto-reply.ts` `showTypingIndicator` | Before an AI reply | Not a message | `sendTypingIndicator` | **Exempt** (not a delivered message; skipped when the AI reply is blocked) |
| 4 | AI auto-reply | `src/lib/ai/auto-reply.ts` → `src/lib/flows/meta-send.ts` `engineSendText` | Inbound webhook | Automated (AI reply) | `sendTextMessage` | **Charged**, feature `ai_agent` |
| 5 | Flow (chatbot) message / media / buttons / list / collect prompt / reprompt | `src/lib/flows/engine.ts` → `src/lib/flows/meta-send.ts` `engineSendText`, `engineSendMedia`, `engineSendInteractiveButtons/List` | Inbound webhook | Automated (chatbot) | `sendText/Media/InteractiveButtons/InteractiveList` | **Charged**, feature `chatbot` |
| 6 | Automation send_message / send_template | `src/lib/automations/engine.ts` → `src/lib/automations/meta-send.ts` `engineSendText`, `engineSendTemplate` | Webhook event, tag event, contact created … | Automated (workflow) | `sendTextMessage`, `sendTemplateMessage` | **Charged**, feature `workflow` |
| 7 | Automation send_buttons / send_list | `src/lib/automations/meta-send.ts` `engineSendInteractive` → flows interactive sender | Same as 6 | Automated (workflow) | `sendInteractiveButtons/List` | **Charged**, feature `workflow` |
| 8 | Scheduled automation steps (after a `wait`) | `src/app/api/automations/cron/route.ts` → `resumePendingExecution` → path 6/7 | Cron | Automated (scheduled) | as 6/7 | **Charged**, feature `workflow` |
| 9 | Dashboard broadcast wizard | `src/hooks/use-broadcast-sending.ts` → `src/app/api/whatsapp/broadcast/route.ts` | User launches a campaign | Automated (broadcast) | `sendTemplateMessage` | **Charged** per recipient, no feature switch |
| 10 | API broadcast (`POST /api/v1/broadcasts`) | `src/lib/whatsapp/broadcast-core.ts` `deliverBroadcast` | API key | Automated (broadcast) | `sendTemplateMessage` | **Charged** per recipient |
| 11 | Broadcast resume / retry failed | `src/app/api/whatsapp/broadcast/[id]/resume/route.ts` → `deliverBroadcast` | User clicks Resume | Automated (broadcast) | `sendTemplateMessage` | **Charged** — reuses the recipient's charge row (no double charge) |
| 12 | Public API send (`POST /api/v1/messages`) | `src/app/api/v1/messages/route.ts` → `sendMessageToConversation` | API key (Zapier, scripts) | Automated (no human in the inbox) | as path 1 | **Charged** (`api` source). Assumption — see §5. |
| 13 | Flows cron (timeouts) | `src/app/api/flows/cron/route.ts` | Cron | — | none (only ends stale runs) | No send |

Retry logic found: the phone-variant loop in every sender (only re-sends after a 4xx "recipient not allowed", so at most one variant is ever accepted), broadcast resume (path 11), and the wizard's whole-batch replay on HTTP 429 (our own rate limiter, before any send). Duplicate Meta webhooks are dropped before any dispatch (`webhook/route.ts`, "duplicate inbound message ignored").

## 3. Identifying tables

| Concept | Table / column |
| --- | --- |
| Account | `accounts.id`. Every tenant row carries `account_id`. Owner: `accounts.owner_user_id`, and `profiles.account_role = 'owner'`. |
| User | `auth.users.id` = `profiles.user_id`. Platform role in `platform_users`. |
| Outgoing message | `messages.id` (uuid, written after the send succeeds) and `messages.message_id` (Meta wamid). Broadcast recipients: `broadcast_recipients.id` and `.whatsapp_message_id`. |

Because `messages` rows are only written after Meta accepts a send, `message_charges.message_id` holds a deterministic **logical message key** created before the send:

| Source | Key |
| --- | --- |
| AI auto-reply | `ai:<inbound wamid>` (fallback `ai:<uuid>`) |
| Automation step | `auto:<automation_log id>:<step id>` |
| Flow step | `flow:<run id>:<node key>:<uuid>` — duplicate inbounds never reach the engine, so a fresh key per send is safe |
| Broadcast recipient | `bc:<broadcast_recipients.id>` (wizard, API and resume all use it) |
| Public API send | `api:<Idempotency-Key header>` if supplied, else `api:<uuid>` |

## 4. Role mapping (D8 → this codebase)

| Spec role | Here |
| --- | --- |
| `super_admin` | `platform_users.platform_role = 'super_admin'` |
| `admin` | `platform_role` in (`admin1`, `admin2`) |
| `customer` (account owner) | `profiles.account_role = 'owner'` of the session's account. Other members of the account see only the balance number (needed for the "automated replies paused" banner). |

## 5. Decisions and assumptions

- **Public API sends (path 12) are charged** as automated. Flip `CHARGE_PUBLIC_API_SENDS` in `src/lib/wallet/policy.ts` if they should be free.
- Broadcasts have no feature switch (D9 lists only chatbot / workflow / ai_agent).
- Feature switches default to **on**, matching today's behaviour (everything always runs). A missing row also counts as on.
- **Wallets are backfilled at 0, as specified.** After migration 045, every automated send on every account (including the super admin's own) is blocked until tokens are granted or a recharge is approved. Manual replies keep working.
- Rate is stored as a fraction `num/den` tokens per rupee (default 1/1). Units credited = `floor(paise × 10 × num / den)`.
- Ambiguous provider outcomes: Meta's Cloud API has no endpoint to look up an outgoing message, and a lost response leaves no wamid to match against status webhooks. So `needs_reconciliation` is resolved by the super admin by hand (mark sent / release). The reconciliation job only escalates charges stuck in `reserved` for more than 10 minutes.

## 6. Stop-condition check

| Condition | Result |
| --- | --- |
| No runnable test environment / database | A local Postgres is available for DB tests; the Vitest runner is present. Not triggered. |
| Existing data conflicts | New tables only; no existing balances. Not triggered. |
| No way to resolve ambiguous sends and no fallback chosen | The task itself specifies the fallback ("manual-review state"). Implemented as a super-admin review queue and reported. |
| Requirement contradicts money-affecting behaviour | None found. Backfilling at 0 does pause automations; it is what D3 and the backfill rule specify, and it is called out in the report. |

## 7. Update 2026-10-13 — platform owner wallet and ₹ adjustments (migration 046)

Requested by the owner with screenshots of a reference "Wallet" screen.

- **The super admin's own account is unlimited.** `token_reserve_charge` answers `unlimited` when the account's owner has `platform_role = 'super_admin'`; the message is sent with no charge row and no ledger row. Every other account is metered exactly as before. This deliberately changes D1 for the platform owner only, at the owner's request.
- **Adjust Wallet works in rupees.** `token_adjust(account, 'credit'|'debit', paise, actor, reason)` converts at the current rate inside the same transaction, writes a `grant` / `admin_deduct` row with the rate and an `inr:<paise>` reference, and refuses a debit below zero. Super admin only.
- **Wallet page for platform admins** shows tenant companies (owner accounts excluded) with balance and total spent in ₹ at the current rate, plus quick stats. Admin 1 / Admin 2 see it read-only and can switch to their own wallet.
- **Not adopted from the screenshot:** Razorpay online recharges. D7 (manual GPay only, no gateway) still stands; changing it needs the owner's decision.
- Usage per account is aggregated in SQL (`token_usage_summary`) instead of loading every charge row.

# Release — 2026-10-10

This release adds roles and subscriptions, Train AI, a free flow test mode, a demo page, an inbox Excel tab and database backup.

## What's new

| # | Area | Change |
| --- | --- | --- |
| 1 | Guide | One folder per update in `Guide/updates/` (and this repo-level `CRM-Updates/` folder, with one folder per kind of work) |
| 2 | Roles | Super admin, Admin 1, Admin 2, Subscription user |
| 3 | Chatbot / Flows | **Test flow** — a free sandbox chat; nothing is sent to WhatsApp |
| 4 | Demo | Demo tab: broadcast funnel, AI training, automation in action, Present mode |
| 5 | Inbox | Data sheet tab: download a chat as Excel / CSV, upload a chat → notes or AI training |
| 6 | AI | **Train AI** tab: profile, Q&A, rules, learn from chats, documents, test, readiness score |
| 7 | Settings | Subscription users: 1 / 7 / 15-day trials, paid / suspend, per-user tab checkboxes, bulk select |
| 8 | Settings | Backup: one click downloads the database as JSON or Excel |

## Setup after pulling

1. `cd wacrm-main && npm install` (adds `exceljs`).
2. In the Supabase SQL editor, run these in order:
   - `wacrm-main/supabase/migrations/043_platform_users_subscriptions.sql`
   - `wacrm-main/supabase/migrations/044_ai_training.sql`
3. `npm run dev`.

The oldest user becomes the Super admin. To pick someone else, see the comment at the top of migration 043.

## Checks

- Typecheck clean. 93 test files / 1,049 tests pass. Production build succeeds.

## Known limits

- Tab access and trial limits are enforced in the app screens; the data API routes don't check them yet.
- New text is in English in all four language files; only menu labels are translated.
- A backup doesn't include uploaded media files or secrets (secrets show as `[redacted]`).

## In-app notes

Each change also has a user-facing note in `wacrm-main/Guide/updates/2026-10-10-*/`.

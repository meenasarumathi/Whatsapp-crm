# Team, roles and subscriptions

| Work | What it does |
| --- | --- |
| Account roles | Owner, Admin, Agent, Viewer; invite links |
| **Platform roles** — **New** | Super admin, Admin 1, Admin 2, Subscription user |
| **Free trials** — **New** | 1, 7 or 15 days; mark paid, end now, suspend; new sign-ups get 7 days automatically |
| **Tab access** — **New** | Checkboxes to choose which sidebar tabs each user sees; select one or many users at once |
| **Add user** — **New** | Create a login with a role, trial and tabs |

Where: Settings → Subscription users. Database: `platform_users` (migration 043).
Code: `src/lib/platform/`, `src/app/api/platform/`, `src/components/settings/subscription-users-panel.tsx`, `src/components/layout/access-guard.tsx`

## Update history

| Date | Change |
| --- | --- |
| 2026-10-10 | Added in this release — see [release notes](../2026-10-10-release/README.md). |

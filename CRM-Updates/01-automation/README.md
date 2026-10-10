# Automation

Rules that run on their own: "when this happens, do that".

| Work | What it does | Where |
| --- | --- | --- |
| Triggers | New message, first message from a contact, keyword match, new contact, conversation assigned, tag added, time-based, button / list reply | Automations tab |
| Actions | Send message, buttons, list or template; add / remove tag; assign conversation; update contact field; create deal; wait; condition; send webhook; close conversation | Automations → builder |
| Ready-made templates | Welcome message, out-of-office, lead qualifier, follow-up reminder | Automations → New |
| Logs | Every run with its result | Automations → Logs |
| Broadcast follow-up funnel (concept) | Reminder for non-readers → follow-up for non-repliers → AI answers → hot-lead handling | Demo tab (showcase) — **New** |

Code: `src/lib/automations/`, `src/components/automations/`, `src/app/api/automations/`

## Update history

| Date | Change |
| --- | --- |
| 2026-10-10 | Added in this release — see [release notes](../2026-10-10-release/README.md). |

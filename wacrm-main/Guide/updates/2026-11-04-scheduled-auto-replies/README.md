# Scheduled auto-replies and contact lists

Reply automatically to the contacts on your own lists, on the days and hours you choose, with an approved template or a text message.

## What changed

- New page: Automations → **Scheduled auto-replies**.
- **Contact lists**: paste numbers or upload a CSV; new numbers become contacts; each list is also a tag.
- **Auto-reply rules**: lists (or everyone) × days × time window × timezone × template or text, with a cooldown per contact and a priority.
- **Recent auto-replies** log with sent / failed status.
- When a rule replies, the AI auto-reply skips that message so the customer gets one answer.
- Database: `tags.is_list`, new tables `auto_reply_rules` and `auto_reply_sends` (`npm run db:init`).

## Who it affects

- Roles: Owner / Admin / Agent can manage lists and rules; Viewer can look.
- Tabs: Automations

## How to use it

1. Automations → **Scheduled auto-replies** → **New list** → paste numbers → **Save list**.
2. **New rule** → pick the list, days, hours and a template → **Save rule**.
3. Message your business number from a listed phone inside the hours to see it reply.

## Related guide chapters updated

- 08 Automations (Scheduled auto-replies)

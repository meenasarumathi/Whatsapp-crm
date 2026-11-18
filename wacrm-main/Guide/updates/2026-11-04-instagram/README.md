# New tab: Instagram

Instagram DMs, comments and story mentions now come into the CRM and can be answered automatically.

## What changed

- New **Instagram** tab with an Inbox, Automations and Connect & test.
- Five ready automations: Comment → DM (with public reply), Keyword reply, Welcome DM, Story mention thanks, Away message. Replies can use Quick replies as templates.
- AI auto-reply on Instagram using Train AI and your documents.
- Webhook at `/api/instagram/webhook` (verify token per account, signature checked).
- Simulation mode until a token is saved, plus a simulator to test without Instagram.
- Automated Instagram replies use the same token wallet as WhatsApp.
- Database: `instagram_accounts`, `instagram_contacts`, `instagram_messages`, `instagram_automations` (`npm run db:init`).
- Subscription users: Instagram can be switched on or off per user like other tabs.

## Who it affects

- Roles: Owner / Admin connect the account; Agents reply and edit automations; Viewers can look.
- Tabs: Instagram (new), Settings → Subscription users

## How to use it

1. Instagram → Automations → edit the texts → switch on.
2. Connect & test → **Simulate message** to see the replies.
3. When ready, connect your Instagram account (see the Instagram chapter).

## Related guide chapters updated

- 17 Instagram (new)

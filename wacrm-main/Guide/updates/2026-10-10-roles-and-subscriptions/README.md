# Super admin, Admin 1, Admin 2 and subscription users

You can now run the CRM as a product: give free trials of 1, 7 or 15 days, and choose which sidebar tabs each user can open.

## What changed

- New platform roles: **Super admin**, **Admin 1**, **Admin 2** and **Subscription user**.
- New settings page: Settings → Platform → **Subscription users**, shown only to platform admins.
- Free trials of **1**, **7** or **15 days**, plus **Mark paid**, **End now** and **Suspend**.
- Checkboxes to choose the sidebar tabs each user can open.
- Row checkboxes to select one or many users and update them all at once: trial, paid, suspend, tabs or role.
- **Add user** creates a login with a temporary password, a role, a trial and tabs.
- New sign-ups get a 7-day free trial with every tab.
- Subscription users see a "days left" strip on every page. When the trial ends, they see "Your free trial has ended" until an admin acts.
- A tab that is switched off disappears from the sidebar, and opening its link shows "This tab isn't on your plan".

## Who it affects

- Roles: Super admin (everything), Admin 1 (manages subscription users), Admin 2 (trials only), Subscription users.
- Tabs: Settings, the sidebar, every page (trial strip and access check).

## How to use it

1. Run `supabase/migrations/043_platform_users_subscriptions.sql` once in the Supabase SQL editor. The oldest user becomes the Super admin, and existing users stay active with all tabs.
2. Open Settings → **Subscription users**.
3. Click a user to give a trial, mark them paid, or tick their tabs and click **Save tabs**.
4. To change many users at once, tick their checkboxes and use the bar that appears.

## Related guide chapters updated

- Getting started → Platform roles and subscriptions; The screen layout
- Settings → Subscription users

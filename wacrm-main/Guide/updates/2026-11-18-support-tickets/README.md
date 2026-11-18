# Support tab: raise complaints and get resolution updates

Users can now raise a complaint inside the CRM, and platform admins resolve it there, with an in-app notification to the user at every step.

## What changed

- New **Support** tab at the bottom of the sidebar, between **Wallet** and **Users**. Always visible to everyone.
- Users raise a complaint with a subject, category, priority and description, and get a ticket number.
- Super admin, Admin 1 and Admin 2 see every ticket, reply, mark it **In progress**, **Resolved** (with a required note) or **Closed**.
- The user gets a **Notifications** alert for every admin reply and status change; clicking it opens the ticket.
- On a resolved ticket the user can confirm the fix (closes it) or reopen it.
- Database: new tables `support_tickets` and `support_ticket_messages`; notifications gain a `ticket_id` column and the new type `support_ticket`. Run `npm run db:init`, then restart the server.

## Who it affects

- Roles: every user (raise and follow tickets); Super admin, Admin 1, Admin 2 (resolve tickets)
- Tabs: Support (new), Notifications

## How to use it

1. Users: **Support** → **Raise a complaint** → fill the form → **Submit**.
2. Admins: **Support** → open a ticket → reply → **Mark Resolved** with a note.
3. Users: open the notification → **Yes, it's fixed** or **Still not fixed — reopen**.

## Related guide chapters updated

- 18 Support (new)
- 04 Notifications

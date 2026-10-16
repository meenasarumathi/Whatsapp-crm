# Settings

Your personal account options and the workspace-wide configuration: WhatsApp connection, templates, quick replies, fields, tags, currency, team and API keys.

Open **Settings** at the bottom of the sidebar. A menu on the left (a scrolling strip on phones) lists the sections in three groups. Sections under **Workspace** can only be changed by **Owners and Admins**.

## Overview

The landing page: a status card per area — whether WhatsApp is **Connected**, **Not set up yet** or **Needs reconnecting**, how many members and pending invites, templates (and how many are pending review), tags and custom fields, and your appearance. Click any card to jump to it.

---

## Account

### Your profile

- **Upload photo / Change photo / Remove** — PNG, JPG, WebP or GIF up to 2 MB.
- **Display name** and **Email** — changing email sends a confirmation to both old and new addresses.
- **Account details** — your **Role**, **Joined** date and **User ID**.
- **Browser notifications** — desktop pop-ups for new customer messages (see the Notifications chapter).

Click **Save changes**.

### Login & security

- **Password** — enter **Current password**, **New password**, **Confirm new password**, then **Update password**.
- **Active sessions** — **Sign out of all devices** if you lost a laptop or shared your password.

### Appearance

- **Mode** — Light or Dark (also via the toggle in the top bar).
- **Accent color** — the highlight colour used across the app.

Saved on this device only and changes live.

---

## Workspace

### WhatsApp (admin) — connect your number

Nothing works until this is done. You need a Meta (Facebook) Business account.

1. Follow the **Setup Instructions** on the page: create a Meta App → add the WhatsApp product → copy your credentials.
2. Fill in **API Credentials**:
   - **Phone Number ID** and **WhatsApp Business Account ID** — digits only, from Meta → WhatsApp → API Setup.
   - **Permanent Access Token** — from Meta Business Settings → System Users.
   - **Webhook Verify Token** — any secret word you make up.
   - **Two-step verification PIN** — only for a real production number; leave blank for Meta test numbers.
3. Click **Save Configuration**, then **Test API Connection**.
4. In Meta → WhatsApp → Configuration, paste the **Webhook Callback URL** shown on this page, enter the same verify token, and subscribe to the **messages** field.
5. Check **Registration status** says "Registered — Meta will deliver events". If messages stop arriving, click **Verify with Meta**.

**Attachment Storage → Keep inbound attachments** saves a copy of customers' photos, videos and documents, because Meta deletes them after about 30 days.

**Reset Configuration** clears everything so you can enter it again.

### Templates (admin) — WhatsApp message templates

Templates are pre-approved messages required for broadcasts and for messaging someone outside the 24-hour window.

- **Sync from Meta** — pull in templates already approved in Meta WhatsApp Manager.
- **New Template**:
  1. **Template Name** — lowercase, digits and underscores (e.g. `order_confirmation`).
  2. **Category** and **Language** (must match Meta's code exactly, e.g. `en_US`).
  3. **Header** — None, Text, Image, Video or Document.
  4. **Body Text** — use {{1}}, {{2}}… for variables, and give **Sample values** for Meta's review.
  5. **Footer** (optional) and **Buttons** (optional): Quick Reply, URL, Phone, Copy Code.
  6. Click **Submit for Approval**. Meta usually reviews within 24 hours; the status updates automatically.
- **Edit** / **Resubmit** — editing sends it back to Meta for review (status becomes PENDING).
- **Delete** — removes it from the CRM and from Meta. Broadcasts using it will start failing.

### Quick replies

Reusable answers agents can insert from the Inbox composer — plain text or a saved interactive message (buttons/list). Add, edit or delete them here. Agents can also save one straight from the composer with **Save as quick reply**.

### Fields & tags (admin)

- **Tags** — colour-coded labels for grouping and filtering contacts (e.g. "VIP", "Newsletter"). Type a name, pick a colour, **Add tag**. Deleting a tag removes it from every contact.
- **Custom fields** — extra contact fields (e.g. ZIP code, Lead source). They appear on every contact, in broadcast audience filters and in the "Update Contact Field" automation step. Deleting a field erases its value on every contact.

### Deals & currency (admin)

**Default currency** for new deals and for all pipeline and dashboard totals. Existing deals keep their own currency.

### Team members (admin)

- See everyone with access, their role and whether they are **online**, **away** or **offline**.
- Change a member's role from the dropdown, or **Remove** them (their login is not deleted).
- **Invite member**:
  1. Choose the **Role** (Admin, Agent, Viewer).
  2. Choose **Link valid for** — 1, 7 or 30 days.
  3. Optional **Label** (e.g. "Sara — support team").
  4. Click **Generate link**, then **Copy** it or **Send via WhatsApp**.
- **Pending invitations** — **Revoke** any unused link.

> **Tip:** The invite link is shown only once. If you lose it, revoke the invite and create a new one.

### Backup (admin)

Make a copy of your CRM data and download it. Do this regularly.

1. Open **Settings → Backup**.
2. Click **Backup & download** for the complete copy as a JSON file, or **Download as Excel** for a workbook with one sheet per table.
3. When it finishes you see how many rows and tables were saved.

The backup contains everything in your workspace: contacts, conversations and messages, deals, pipelines, broadcasts, automations, flows, templates, tags, notes, AI setup and training. The **Super admin** also sees **Full database backup**, which covers every account and user.

Not included: secrets (shown as `[redacted]` — re-enter them after a restore), uploaded media files, and AI search vectors.

> **Tip:** The file holds your customers' personal data. Store it securely.

### Subscription users (Super admin, Admin 1, Admin 2)

Shown under **Platform** in the settings menu, only to platform admins. It lists everyone using your CRM.

- **Role** — Super admin, Admin 1, Admin 2 or Subscription user. Only the Super admin can change roles.
- **Plan** — Free trial (with days left), Paid, Expired or Suspended.
- **Tabs** — how many sidebar tabs the person can open.

Click a row to open it:

1. **Subscription** — give a free trial of **1 day**, **7 days** or **15 days** (it starts now), **Mark paid**, **End now** or **Suspend**.
2. **Tabs this user can open** — tick the tabs they should see (Dashboard, Inbox, Train AI, Notifications, Contacts, Pipelines, Broadcasts, Automations, Flows, AI Agents, Demo, Guide). Use **Select all** / **Clear**, then **Save tabs**.
3. **Internal notes** — e.g. how they paid.

**Many users at once:** tick the checkboxes on the left of the list (or the one in the header for everyone shown). A bar appears to give them all a 1 / 7 / 15-day trial, mark them paid, suspend them, set their tabs or change their role in one go.

**Add user** creates a login straight away: name, email, a temporary password, role, free trial length and tabs.

New sign-ups automatically get a **7-day free trial** with every tab. Settings is always available to everyone.

> **Tip:** First time? Run `supabase/migrations/043_platform_users_subscriptions.sql` in the Supabase SQL editor. The oldest user becomes the Super admin.

### API keys (admin)

For connecting other software (e.g. Zapier) to the CRM through its REST API (`/api/v1`).

1. Click **New API key**, give it a **Name** and tick only the **Scopes** it needs.
2. Click **Create key** and **Copy** it immediately — it is shown only once.
3. **Revoke** a key to stop it working.

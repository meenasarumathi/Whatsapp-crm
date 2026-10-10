# Broadcasts

Send one approved WhatsApp template to many contacts at once, then track delivery, reads and replies.

> **Before you start:** WhatsApp only allows bulk messages using **approved templates**. Create or sync one in Settings → Templates first.

## The broadcasts list

Shows every broadcast with **Name**, **Template**, **Recipients**, **Delivery**, **Read**, **Status** and **Date**. Statuses: **Draft**, **Scheduled**, **Sending**, **Sent**, **Failed**.

Click **New Broadcast** to start the 4-step wizard.

## Step 1 — Template

Choose an approved template. If none appear, create one in Settings → Templates.

## Step 2 — Audience

Pick who receives it:

| Option | Who gets it |
| --- | --- |
| **All Contacts** | Everyone in your contacts. |
| **Filter by Tags** | Contacts with the **Select Tags** you choose. Use **Exclude Tags** to leave some out. |
| **Custom Field** | Contacts matching a rule: pick a **Field**, an **Operator** (**Is**, **Is not**, **Contains**) and a **Value**. |
| **Upload CSV** | Numbers from a file with a **phone** column (with + and country code) and an optional **name** column. |

The **Audience Summary** shows how many people will receive it.

## Step 3 — Personalize

Templates contain placeholders like {{1}}, {{2}}. For each one choose a **Type**:

- **Static Value** — the same text for everyone (e.g. "20% off").
- **Contact Field** — the contact's **Name**, **Phone** or **Email**.
- **Custom Field** — one of your custom fields.

If the template has an image header, paste an **Image URL**. Check the **Preview** on the right. Every placeholder must be mapped before you continue.

## Step 4 — Send

1. Enter a **Broadcast Name** (e.g. "Summer Promo").
2. Review the **Summary** and **Estimated Reach**.
3. Click **Send Broadcast** and confirm — or **Save as Draft** to finish later.

> **Tip:** Keep the browser tab open while it says "Sending…". If the tab is closed early, the broadcast page offers **Resume sending** to finish from the server.

## Broadcast results

Click a broadcast to see:

- **Funnel / stats** — **Total Recipients**, **Sent**, **Delivered**, **Read**, **Replied**, **Failed**.
- **Recipients** table — each contact's status, times and any **Error**. Filter by status and **Export CSV**.
- **Retry failed (N)** — re-send to recipients that failed.
- **Delete** — remove the broadcast (not allowed while it is sending).

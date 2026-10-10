# FAQ & troubleshooting

Answers to the questions new users ask most, and fixes for common problems.

## Messages

**I can't type a reply — it says "Session expired".**
More than 24 hours have passed since the customer last wrote. Send an approved template (composer → **Templates**). Once they reply you can chat freely again.

**The box says "Read-only — viewers can browse but not reply".**
Your role is Viewer. Ask an admin to change you to Agent in Settings → Team members.

**A message shows "Not delivered".**
Usually the number is wrong (missing country code), the person is not on WhatsApp, or Meta rejected the message. Check the phone number on the contact.

**No new messages are arriving.**
An admin should open Settings → WhatsApp and click **Verify with Meta**. Registration must say "Registered". If the token changed, re-enter it and **Save Configuration**.

**A photo or document says "This attachment is no longer available".**
Meta deletes media after about 30 days. Turn on **Keep inbound attachments** in Settings → WhatsApp to keep future files.

## Contacts

**"A contact with this phone number already exists."**
Click **View** to open the existing contact instead of creating a duplicate.

**My CSV import skipped rows as "invalid phone".**
Every number must start with + and the country code, e.g. +919876543210.

**Tags from my CSV were not added.**
Tags must exist before importing. Create them in Settings → Fields & tags, then import again.

## Templates & broadcasts

**My template isn't in the list.**
Only **approved** templates appear. Check its status in Settings → Templates, or click **Sync from Meta**.

**My broadcast stopped part-way.**
The browser tab was probably closed. Open the broadcast and click **Resume sending**.

**Some recipients failed.**
Open the broadcast, filter by **Failed**, read the **Error** column, then click **Retry failed**.

## Automations, flows & AI

**My automation did not fire.**
Make sure it is **Active**, then open **View Logs**. Check the keywords and match type (Whole word vs Contains).

**I can't activate my flow.**
Fix every error in the validation panel first (each one links to the problem node).

**The AI didn't reply to a customer.**
Auto-reply only runs when no flow is handling the chat and no agent is assigned, and it stops after the **Max auto-replies** limit.

**"AI isn't set up yet" when I click Draft with AI.**
An admin must finish AI Agents → Setup and switch on **Enable AI assistant**.

## Account

**I forgot my password.**
On the sign-in page click **Forgot password?** and follow the email link.

**My invite link doesn't work.**
It may have expired or been used. Ask an admin to revoke it and create a new one.

**I want to change my email.**
Settings → Your profile → change **Email** → confirm from both your old and new inboxes.

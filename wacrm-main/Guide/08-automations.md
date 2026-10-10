# Automations

"When this happens, do that" rules that react to WhatsApp events automatically — auto-replies, tagging, assigning, follow-ups.

## The automations list

- **Quick-start templates** — ready-made automations you can start from:
  - **Welcome Message** — greets first-time contacts.
  - **Out of Office** — replies during off-hours.
  - **Lead Qualifier** — asks qualification questions.
  - **Follow-up Reminder** — nudges a contact who has not replied in 24 hours.
- **Create Automation** — start from scratch.
- Each automation shows whether it is **active**, its run count and when it last ran.
- The **⋯** menu on each: **Activate / Deactivate**, **Edit**, **Duplicate**, **View Logs**, **Delete**.

## How an automation is built

An automation has **one trigger** followed by **steps** that run in order.

### Triggers — "when…"

| Trigger | Fires when |
| --- | --- |
| **New Message Received** | Any incoming message. |
| **First Message from Contact** | A contact messages you for the very first time. |
| **Keyword Match** | A message contains your **Keywords** (comma-separated, e.g. "price, buy"). Choose match type: **Contains**, **Whole word** or **Exact**. |
| **Button / List Reply** | A customer taps a button or list row whose **Reply ID** matches. |
| **New Contact Created** | A contact is auto-created from an incoming message. |
| **Conversation Assigned** | A chat is assigned to an agent. |
| **Tag Added** | A tag is added to a contact. |
| **Time-Based** | On a schedule — a cron expression like `0 9 * * 1-5` (9:00 on weekdays) or a time like `09:00`. |

### Steps — "then…"

Click **Add step** and pick one:

| Step | What it does |
| --- | --- |
| **Send Message** | Sends a text reply. |
| **Send Buttons** / **Send List** | Sends tappable options; their reply IDs can trigger other automations. |
| **Send Template** | Sends an approved template (works outside the 24-hour window). |
| **Add Tag** / **Remove Tag** | Changes the contact's tags. |
| **Assign Conversation** | Assigns the chat **Round-robin** across agents or to a **Specific agent**. |
| **Update Contact Field** | Sets a contact field or custom field (can use values like `{{ message.text }}`). |
| **Create Deal** | Creates a deal in the chosen pipeline and stage. |
| **Wait** | Pauses for a number of **Minutes**, **Hours** or **Days**. |
| **Condition (If/Else)** | Splits into **Yes** and **No** branches based on **Tag presence**, a **Contact field**, **Message content** or **Time of day**. |
| **Send Webhook** | Calls another system's URL with data. |
| **Close Conversation** | Sets the chat to Closed. |

Use **Move up / Move down** to reorder and **Delete** to remove a step.

## Creating an automation — step by step

1. Click **Create Automation** (or a quick-start template).
2. Give it a name at the top.
3. Choose the **Trigger type** and fill in its settings.
4. Add your steps.
5. Switch **Active** on, then click **Save** (or **Save Draft** to keep it off).

### Example: tag and assign price enquiries

- Trigger: **Keyword Match** — keywords "price, cost, quote".
- Step 1: **Add Tag** — "Lead".
- Step 2: **Assign Conversation** — Round-robin.
- Step 3: **Send Message** — "Thanks! A teammate will send you prices shortly."

## Checking that it works — Execution logs

From the ⋯ menu choose **View Logs**. Each run shows the contact, time, the steps that ran and a result: **success**, **partial** (some steps failed) or **failed**. Expand a run to see each step.

> **Tip:** Test with your own personal WhatsApp number before switching an automation on for everyone.

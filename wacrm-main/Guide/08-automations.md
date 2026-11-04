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
| **Add Tag** / **Remove Tag** | Changes the contact's tags. Pick a tag, or click **New tag** to create one on the spot. |
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

## Workflow library

Six ready-made workflows (lead capture, prices, order tracking, human hand-off, payment reminder, delivery feedback) are listed at the top of the Automations page. **Install** creates them as drafts with their tags and pipeline already chosen. See Workflows for what each one does.

**Assign Conversation → Round-robin** now gives the chat to the teammate with the fewest open conversations (viewers are skipped).

## Scheduled auto-replies

Automations → **Scheduled auto-replies** answers chosen customers automatically, on the days and hours you set, with an approved template or a text message. No builder needed.

### 1. Make a contact list

1. Click **New list** and give it a name, for example "VIP parents".
2. Paste phone numbers (one per line or comma-separated) or click **Upload CSV** (a name column is picked up too).
3. 10-digit numbers get the **Default country code** (91 for India). Click **Save list**.

New numbers become contacts. A list is also a tag, so you can reuse it in broadcasts and automations. Use **Add numbers** to grow a list later. Importing never sends a message.

### 2. Add a rule

| Setting | What it does |
| --- | --- |
| **Who** | One or more lists, or **Everyone**. |
| **When** | Days of the week, **From** / **To** time and **Timezone**. An end time before the start runs past midnight (18:00–09:00 = after hours). |
| **What** | An **Approved template** (fill each {{1}}, {{2}} — use {{contact.name}} for the name) or a **Text message**. |
| **Reply to the same contact at most** | Cooldown, for example **Once every 12 hours**, so a chatty customer is not answered on every message. |
| **Priority** | When several rules match, the lowest number replies. Only one rule replies per message. |

When a rule replies, the AI auto-reply stays quiet for that message, so the customer gets one answer. Flows still take precedence over scheduled replies.

### 3. Check it

**Recent auto-replies** at the bottom shows each send with the contact, rule and **Sent** / **Failed** (hover a failure for the reason, for example an empty token wallet).

> **Tip:** Add your own number to a test list first and message the business number from your phone inside the rule's hours.

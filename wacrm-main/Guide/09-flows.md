# Flows (Beta)

Visual chat-bots: branching, button-driven conversations for menus, FAQs and lead capture before a human steps in.

## Flows vs Automations

- **Automations** are short rules: one trigger → a list of actions.
- **Flows** are full conversations: the bot asks, the customer taps or types, and the bot follows a different path for each answer.

## The flows list

Each flow shows its status — **Draft**, **Active** or **Archived** — its trigger, number of nodes and runs. Click **New flow** to create one.

### Start from a template

- **Welcome menu** — greets people who type a keyword and routes new vs existing customers to the right agent.
- **FAQ bot** — customer picks a topic from a list; the bot answers.
- **Lead capture** — on a first-ever message, asks name, email and company, then hands off to sales.

Or enter a name under **Or start blank** and click **Create blank flow**.

## The flow editor

Switch between **Canvas** (a visual diagram) and **List** views. Click a node to edit it in the side panel.

### Trigger — "When…"

- **A message contains a keyword** — enter **Keywords** (comma-separated).
- **Customer's first ever inbound message**.
- **Manual only (no auto-trigger)**.

Set the **Entry node** — the first step that runs.

### Node types (Add node)

**Messaging**

| Node | What it does |
| --- | --- |
| **Start** | Entry point of the flow. |
| **Send message** | Sends a text message. |
| **Send buttons** | Sends 1–3 quick-reply buttons; each button leads to a different next node. |
| **Send list** | Sends a tappable list (up to 10 rows in sections); each row leads somewhere. |
| **Send media** | Sends an image, video or document (up to 16 MB) with an optional caption. |

**Logic & data**

| Node | What it does |
| --- | --- |
| **Collect input** | Asks a question and saves the reply in a variable (e.g. `name`, `email`). |
| **If / else** | Branches on a captured variable, a tag, or a contact field (equals / contains / is present / is absent). |
| **Tag contact** | Adds or removes a tag. |

**Flow control**

| Node | What it does |
| --- | --- |
| **Handoff to agent** | Passes the chat to a human with an **Internal note** (can include captured answers). |
| **End** | Finishes the flow. |

Each node has an "Advances to" / "Next node" setting that links it to the next step.

### Test flow — try it for free

Click **Test flow** (green button in the editor toolbar) to chat with your flow in a sandbox before going live. **Nothing is sent to WhatsApp**, so testing never costs anything on your WhatsApp bill.

1. Set up a pretend customer: name, phone, email, company and any tags they already have.
2. Type the customer's **first message** — it is checked against the flow's trigger, just like a real message.
3. Click **Start test**. The flow's messages appear as chat bubbles. Tap buttons and list rows, or type replies, as the customer would.
4. Small grey notes show what happened behind the scenes: answers saved, conditions checked, tags added, handoffs. Click one to highlight that step on the canvas.
5. **Restart** to try another path.

The test uses your latest edits, even before you click **Save**. Tags and saved answers only change on the pretend customer.

### Saving and going live

1. Click **Save**. Unsaved changes are flagged at the top.
2. Check the validation panel at the bottom — it lists errors and warnings; click one to jump to the node. A long list scrolls inside the panel, and **Hide** / **Show** collapses it to give the editor more room. "No issues. Ready to activate." means you are good.
3. Click **Activate**. Use **Pause** to stop it, or **Delete** to remove it (any running conversations end).

## Runs (history)

Click **Runs** to see the last 50 times the flow ran: the contact, where it got to, how long it ran, captured variables and a step-by-step log. Run statuses: **Active**, **Completed**, **Handed off**, **Timed out**, **Paused by agent**, **Failed**.

> **Tip:** Message your business number from your own phone with the trigger keyword to test a flow before your customers do.

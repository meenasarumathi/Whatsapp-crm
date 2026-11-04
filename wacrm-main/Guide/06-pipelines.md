# Pipelines

A visual sales board: deals move left-to-right through stages until they are won or lost.

## Key ideas

- A **pipeline** is a sales process (e.g. "Enterprise Sales", "Retail Orders"). You can have several.
- Each pipeline has **stages** — the columns on the board.
- A **deal** is one sales opportunity, linked to a contact. It sits in one stage at a time.

## Creating your first pipeline

1. Click **Create Pipeline** (or **Add Pipeline**).
2. Enter a **Pipeline Name**, e.g. "Enterprise Sales".
3. Under **Start from** pick a template:
   - **Lead to payment settled (team hand-off)** — **New enquiry → Qualified → Quote sent → Order confirmed → Payment received → Dispatched → Settled / Lost**, each with an SLA. This is the default.
   - **Sales funnel** — **New Lead → Qualified → Proposal Sent → Negotiation → Won**.
4. Click **Create Pipeline**.

Switch between pipelines with **Select Pipeline** at the top.

## Managing stages (Manage Pipelines)

Click **Manage Pipelines** to:

- Rename the pipeline (**Pipeline Name**).
- Add a stage — type a **New stage name** and click **Add**.
- Reorder stages — drag the handle (**Drag to reorder**).
- Change a stage's colour — click the colour dot.
- **Stage owner** — the teammate responsible for that step. When a deal enters the stage it is handed to them and they get a notification.
- **SLA h** — how many hours a deal may sit in the stage. After that its card turns red (**Overdue**).
- **Stage outcome** — **In progress**, **Settled (won)** or **Lost**. Dropping a deal on a Settled stage marks it won; on a Lost stage, lost; dragging it back out reopens it.
- Delete a stage — first move or delete the deals in it.
- **Delete Pipeline** — archives all its deals; cannot be undone.

Click **Save Changes** when done.

## Working with deals

### Create a deal

1. Click **Add Deal** (top) or **Add Deal** at the bottom of a stage column.
2. Fill in:
   - **Title** (required) — e.g. "50 units – Acme".
   - **Contact** (required) — who the deal is with.
   - **Link to Conversation** — optional, ties it to a WhatsApp chat.
   - **Value** and **Currency**.
   - **Expected Close Date**.
   - **Stage** (required).
   - **Assigned To** — the teammate who owns it.
   - **Notes**.
3. Click **Create Deal**.

### Move a deal

Drag the card from one column and drop it in another ("Drop a deal here"). If the new stage has an owner, the deal is assigned to them automatically and they are notified (Notifications → click it to open the deal). Every move is kept in the deal's stage history with the time it spent in the previous stage.

### Team hand-off from entry to settlement

Each card shows how long it has been in its stage and who owns it. Use the chips above the board:

- **All deals** — everything in the pipeline.
- **My deals** — deals assigned to you.
- **Overdue** — deals past their stage SLA, so nothing gets stuck between teammates.

> **Tip:** Example for a book shop — Sales owns New enquiry to Quote sent, Accounts owns Order confirmed and Payment received, Dispatch owns Dispatched. Each person works from **My deals**.

### Win, lose or reopen

Open the deal and under **Status** click **Mark as Won** or **Mark as Lost**. Closed deals show a Won/Lost badge. **Reopen deal** puts it back in play. **Delete Deal** removes it.

## Pipeline analytics (numbers above the board)

Hover the ⓘ next to each for "How it is calculated".

| Number | Meaning |
| --- | --- |
| **Total Deals** | All deals in this pipeline except Lost ones. |
| **Pipeline Value** | Sum of those deals' values. |
| **Avg Deal Size** | Pipeline Value ÷ Total Deals. |
| **Weighted Value** | Expected revenue: each open deal's value × its stage probability (first stage ≈ 10%, rising to 90%; Won = 100%). |
| **Won This Month** / **Lost This Month** | Deals closed since the 1st of this month. |

> **Tip:** The currency used for totals is set in Settings → Deals & currency.

## Typical sales workflow

1. A new lead messages you → you reply in the Inbox.
2. Create a deal in **New Lead**, linked to the contact and conversation.
3. Drag it through **Qualified → Proposal Sent → Negotiation** as talks progress.
4. **Mark as Won** (or Lost). The Dashboard and analytics update automatically.

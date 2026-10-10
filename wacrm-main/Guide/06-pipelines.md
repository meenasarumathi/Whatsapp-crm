# Pipelines

A visual sales board: deals move left-to-right through stages until they are won or lost.

## Key ideas

- A **pipeline** is a sales process (e.g. "Enterprise Sales", "Retail Orders"). You can have several.
- Each pipeline has **stages** — the columns on the board.
- A **deal** is one sales opportunity, linked to a contact. It sits in one stage at a time.

## Creating your first pipeline

1. Click **Create Pipeline** (or **Add Pipeline**).
2. Enter a **Pipeline Name**, e.g. "Enterprise Sales".
3. Click **Create Pipeline**. Default stages are added for you: **New Lead → Qualified → Proposal Sent → Negotiation → Won**.

Switch between pipelines with **Select Pipeline** at the top.

## Managing stages (Manage Pipelines)

Click **Manage Pipelines** to:

- Rename the pipeline (**Pipeline Name**).
- Add a stage — type a **New stage name** and click **Add**.
- Reorder stages — drag the handle (**Drag to reorder**).
- Change a stage's colour — click the colour dot.
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

Drag the card from one column and drop it in another ("Drop a deal here").

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

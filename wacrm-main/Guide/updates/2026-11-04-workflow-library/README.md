# Workflow library: six ready-made workflows

Install the six workflows every WhatsApp business needs in one click, already connected to your tags and pipeline.

## What changed

- Automations → **Workflow library**: Welcome & lead capture, Price & catalogue enquiry, Order tracking, Human hand-off & complaints, Payment reminder, Delivery feedback & reviews.
- Installing creates the needed tags and the **Lead to Settlement** pipeline if missing, and saves the automations as drafts.
- The welcome menu buttons lead straight into the price, tracking and hand-off workflows.
- Round-robin assignment now picks the teammate with the fewest open chats.
- Built-in scheduler: with `AUTOMATION_CRON_SECRET` set, the app runs the automation, flow and wallet crons itself every minute, so Wait steps work without an external pinger (`BUILTIN_SCHEDULER=false` turns it off).
- Each workflow is tested end to end against the real automation engine (16 scenarios).

## Who it affects

- Roles: Owner / Admin / Agent can install.
- Tabs: Automations, Pipelines

## How to use it

1. Automations → Workflow library → **Install** on each card.
2. **Open** it, replace the ___ placeholders (prices, UPI id, review link) and **Save**.
3. Switch **Active** on.

## Related guide chapters updated

- 08 Automations
- 12 Workflows

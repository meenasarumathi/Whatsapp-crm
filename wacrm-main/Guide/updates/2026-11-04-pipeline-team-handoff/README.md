# Team pipeline: lead to payment settled

Pipelines now pass each deal from teammate to teammate, from the first enquiry to settled payment, with SLAs so nothing gets stuck.

## What changed

- New pipeline template **Lead to payment settled**: New enquiry → Qualified → Quote sent → Order confirmed → Payment received → Dispatched → Settled / Lost (default for new pipelines).
- Manage Pipelines: each stage has a **Stage owner**, an **SLA** in hours and an **outcome** (In progress / Settled / Lost).
- Moving a deal into a stage hands it to the stage owner and notifies them; Settled and Lost stages close the deal; moving back reopens it.
- Cards show time in stage and a red **Overdue** badge; filters **All deals / My deals / Overdue**.
- Stage history per deal (who moved it, time spent in each stage).
- Database: `pipeline_stages.owner_profile_id / sla_hours / outcome`, `deals.stage_entered_at / settled_at`, table `deal_stage_history`, notification type `deal_assigned` (`npm run db:init`).

## Who it affects

- Roles: Owner / Admin set stage owners; every teammate sees their deals under My deals.
- Tabs: Pipelines, Notifications

## How to use it

1. Pipelines → **Add Pipeline** → keep **Lead to payment settled** → **Create Pipeline**.
2. **Manage Pipelines** → pick a **Stage owner** for each stage → **Save Changes**.
3. Drag deals forward; the next owner is notified and sees them under **My deals**.

## Related guide chapters updated

- 06 Pipelines

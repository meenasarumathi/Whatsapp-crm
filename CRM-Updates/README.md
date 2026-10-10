# CRM Updates

Everything about the WhatsApp CRM, in two kinds of folder:

- **Work folders** — one per kind of work: what it does, where it is in the app, where the code is, and its update history.
- **Release folders** — one per update (`YYYY-MM-DD-name/`): what changed and how to set it up.

## Work folders

| Folder | Work | Status |
| --- | --- | --- |
| [01-automation](01-automation/README.md) | Automation — triggers, actions, templates, logs | Updated 2026-10-10 |
| [02-chatbot](02-chatbot/README.md) | Chatbot (Flows) — flow builder, test mode | Updated 2026-10-10 |
| [03-ai-agent](03-ai-agent/README.md) | AI agent — auto-reply, drafts, handoff, knowledge base | Original |
| [04-ai-training](04-ai-training/README.md) | AI training — Train AI tab | New 2026-10-10 |
| [05-workflow](05-workflow/README.md) | Workflow — how the pieces connect end to end | Original |
| [06-broadcast](06-broadcast/README.md) | Broadcasts and the broadcast funnel | Updated 2026-10-10 |
| [07-inbox](07-inbox/README.md) | Inbox — shared inbox, Excel data sheet | Updated 2026-10-10 |
| [08-contacts-pipelines](08-contacts-pipelines/README.md) | Contacts, pipelines, dashboard, notifications | Original |
| [09-roles-subscriptions](09-roles-subscriptions/README.md) | Super admin, Admin 1, Admin 2, subscription users, trials | New 2026-10-10 |
| [10-backup](10-backup/README.md) | Database backup | New 2026-10-10 |
| [11-demo](11-demo/README.md) | Demo page for prospects | New 2026-10-10 |
| [12-guide-api](12-guide-api/README.md) | In-app guide, REST API, MCP server | Original |

## Release folders

| Date | Release | Highlights |
| --- | --- | --- |
| 2026-10-10 | [2026-10-10-release](2026-10-10-release/README.md) | Roles & subscriptions, Train AI, flow test mode, demo page, inbox Excel tab, database backup |
| 2026-10-08 | In-app guide | User guide inside the CRM, flow errors panel |

## Adding an update

1. Create a release folder `CRM-Updates/YYYY-MM-DD-short-name/` with a `README.md`.
2. In each work folder the change touches, add a row to its **Update history** table.
3. If it's a new kind of work, add a new numbered work folder and a row to the table above.
4. Add the user-facing note in `wacrm-main/Guide/updates/YYYY-MM-DD-name/README.md`, so it shows in the app under Guide → What's new.

The application code is in [`wacrm-main/`](../wacrm-main). All code paths in these folders are relative to it.

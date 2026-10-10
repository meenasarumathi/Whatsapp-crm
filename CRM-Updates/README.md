# CRM Updates

Every change to the WhatsApp CRM is recorded here, one folder per release, so anyone opening this repository can see what was built, when, and how to switch it on.

| Path | What it holds |
| --- | --- |
| [WORK-LIST.md](WORK-LIST.md) | Everything the CRM does, grouped by area: automation, chatbot, AI agent, workflow and more. |
| `YYYY-MM-DD-name/README.md` | One folder per release: what changed, the setup steps, and where the code lives. |

## Releases

| Date | Release | Highlights |
| --- | --- | --- |
| 2026-10-10 | [Release](2026-10-10-release/README.md) | Roles & subscriptions, Train AI, flow test mode, demo page, inbox Excel tab, database backup |
| 2026-10-08 | In-app guide | User guide inside the CRM, flow errors panel |

## Adding a new update

1. Create a folder `CRM-Updates/YYYY-MM-DD-short-name/` with a `README.md`.
2. Add a row to the Releases table above.
3. If a feature was added or changed, update [WORK-LIST.md](WORK-LIST.md).
4. Also add the user-facing note in `wacrm-main/Guide/updates/YYYY-MM-DD-name/README.md`, so it shows in the app under Guide → What's new.

The application code is in [`wacrm-main/`](../wacrm-main). `WACRM1/` is an older copy kept for reference.

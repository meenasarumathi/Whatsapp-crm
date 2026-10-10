# Database backup from Settings

A new **Backup** section in Settings copies your CRM data and downloads it to your computer in one click.

## What changed

- New section: Settings → Workspace → **Backup**.
- **Backup & download** saves a JSON file with every table of your account: contacts, conversations, messages, deals, pipelines, broadcasts, automations, flows, templates, tags, notes, AI setup and training.
- **Download as Excel** gives the same data as a workbook, one sheet per table, plus an "About this backup" sheet.
- The Super admin also gets **Full database backup**: every account and user, including subscription and trial details.
- After each backup, a summary shows the row and table counts, along with the last backup time on this computer.
- Secrets (WhatsApp access token, AI / API keys, webhook secrets) are replaced with `[redacted]`. Uploaded media files and AI search vectors are not included.

## Who it affects

- Roles: Owner and Admin (account backup), Super admin (full backup). Hidden from Agents and Viewers.
- Tabs: Settings.

## How to use it

1. Open **Settings → Backup**.
2. Click **Backup & download** (or **Download as Excel**).
3. Keep the file somewhere safe — it contains your customers' personal data.

## Related guide chapters updated

- Settings → Backup

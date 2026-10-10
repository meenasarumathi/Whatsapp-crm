# Guide folder

This folder is the **user guide for the CRM**. Every `.md` file here is shown
inside the app under **Guide** in the left sidebar (`/guide`), so what you write
here is exactly what your team reads.

## How it is organised

| Path | What it holds | Where it shows in the app |
| --- | --- | --- |
| `NN-topic.md` | One chapter per tab of the CRM. The number sets the order. | Guide → chapter list |
| `updates/YYYY-MM-DD-short-name/README.md` | One folder per change made to the CRM. Screenshots, SQL or notes for that change go in the same folder. | Guide → **What's new** (newest first) |
| `README.md` (this file) | Notes for whoever maintains the guide. | Not shown in the app |

The first `# Heading` of each file is used as its title in the app, and the
first paragraph under it is used as the one-line summary.

## Adding a new chapter

1. Create `Guide/NN-topic.md` (for example `14-reports.md`).
2. Start it with `# Title` and a one-sentence summary paragraph.
3. Reload the Guide page — it appears automatically. No code change needed.

## Recording a change to the CRM (do this every time)

Whenever the CRM is changed — a new tab, a new option, a changed workflow —
add a new folder under `Guide/updates/`:

1. Copy the folder `updates/_TEMPLATE/` to `updates/YYYY-MM-DD-short-name/`
   (use the date of the change). Only its `README.md` is shown in the app;
   anything else in the folder (screenshots, SQL, notes) is kept with it.
2. Fill in what changed, who it affects, and how to use it.
3. If the change alters how an existing tab works, also update that tab's
   chapter so the guide stays correct.

Files and folders whose names start with `_` are ignored by the app.

## Formatting that the in-app viewer supports

- `#`, `##`, `###` headings
- Paragraphs, **bold**, `inline code`, [links](/inbox)
- Bulleted (`-`) and numbered (`1.`) lists, with one level of nesting (indent 2 spaces)
- Tables (`| a | b |`)
- Quotes (`> **Tip:** …`) — shown as a highlighted tip box
- `---` for a divider

Keep to these and the page will render cleanly.

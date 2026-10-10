@AGENTS.md

## User guide (`Guide/` folder) — keep it current

The in-app **Guide** (`/guide`, sidebar → Guide) renders the markdown in `Guide/`.
For **every** change to the CRM (new tab, option, workflow, behaviour change):

1. Add a folder `Guide/updates/YYYY-MM-DD-short-name/` with a `README.md`
   (copy `Guide/updates/_TEMPLATE/`). One folder per change; put any SQL,
   screenshots or notes for that change in the same folder. It appears
   automatically under Guide → "What's new".
2. Update the affected chapter (`Guide/NN-*.md`) so the guide stays accurate.
3. New top-level tab → add a new `Guide/NN-topic.md` chapter (and an icon in
   `CHAPTER_ICONS` in `src/app/(dashboard)/guide/page.tsx`).

Only the markdown subset listed in `Guide/README.md` is rendered (no italics).

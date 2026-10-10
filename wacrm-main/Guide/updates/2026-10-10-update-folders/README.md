# One folder per CRM update

Every change to the CRM now gets its own folder in the Guide, so its notes, screenshots and SQL stay together.

## What changed

- Updates live in `Guide/updates/YYYY-MM-DD-name/README.md` instead of single files.
- Anything else in that folder (screenshots, SQL, notes) is kept with the update but not shown in the app.
- The two earlier updates were moved into folders. Nothing changes in the app: they still show under Guide → What's new.

## Who it affects

- Roles: whoever maintains the CRM and its guide.
- Tabs: Guide → What's new.

## How to use it

1. Copy the folder `Guide/updates/_TEMPLATE/` to `Guide/updates/YYYY-MM-DD-short-name/`.
2. Fill in its `README.md`.
3. Reload the Guide page — it appears under What's new.

## Related guide chapters updated

- `Guide/README.md` (maintainer notes)

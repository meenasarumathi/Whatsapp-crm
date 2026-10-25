# Release — 2026-10-25: Remove the committed encryption key

`wacrm-main/.env.local.example` contained a working `ENCRYPTION_KEY` (commit `4f05b92d`). This key encrypts every saved WhatsApp access token, so anyone with the repo could decrypt tokens from a database that used it.

Branch: `fix/2026-10-25-env-example-secret`

## What changed

| Area | Change |
| --- | --- |
| `.env.local.example` | `ENCRYPTION_KEY` is now a placeholder |
| README / CONTRIBUTING | Setup line mentions filling in `ENCRYPTION_KEY` |

## Apply (every install that used the old key)

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set it as `ENCRYPTION_KEY` in that server's `.env.local` and restart.
3. Settings → WhatsApp: re-enter the access token and save.
4. Optional: in Meta Business Settings, generate a new System User token and revoke the old one, in case it was decrypted.

The old key stays in git history. Removing this file change doesn't make it secret again, so the rotation in steps 1–3 is what fixes the exposure.

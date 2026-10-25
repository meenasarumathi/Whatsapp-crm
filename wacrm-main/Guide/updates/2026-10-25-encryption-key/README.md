# New WhatsApp encryption key

The sample settings file no longer contains a real encryption key, so every install must now create its own.

## What changed

- `.env.local.example` has a placeholder for `ENCRYPTION_KEY` instead of a working key. An earlier version shipped a real key, so any install that copied it must switch to a new one.

## Who it affects

- Roles: Owner / Admin (whoever runs the server and connects WhatsApp)
- Tabs: Settings → WhatsApp

## How to use it

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Put it in `.env.local` as `ENCRYPTION_KEY=...` and restart the server.
3. Open **Settings → WhatsApp**, paste the **Permanent Access Token** again and click **Save Configuration**. The token saved under the old key can't be read with the new one.

## Related guide chapters updated

- None

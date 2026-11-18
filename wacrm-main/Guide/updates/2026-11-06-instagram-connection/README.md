# Instagram connection, like WhatsApp

Instagram now has a card in Settings → Overview and a full connection screen that shows whether messages can really arrive.

## What changed

- Settings → **Overview**: Instagram card showing **Connected**, **Connected · not receiving messages**, **Needs reconnecting** or **Not set up yet**.
- **Save & connect** now also subscribes your account to messages and comments. Without this Meta delivers nothing, so accounts saved earlier must be saved again.
- Connect & test: live token check, subscription status with the reason on failure, **Verify with Instagram**, last event received, and a warning when the webhook address is not public HTTPS.
- Tokens refresh automatically before their 60 days run out.
- The verify token is visible to admins only.

## Who it affects

- Roles: Owner / Admin connect; everyone sees the status.
- Tabs: Settings → Overview, Settings → Instagram

## How to use it

1. Settings → Overview → **Instagram**.
2. Follow **Setup steps**, paste your token and click **Save & connect**.
3. Check that both banners are green, then send a test DM from another account.

## Related guide chapters updated

- 11 Settings
- 17 Instagram

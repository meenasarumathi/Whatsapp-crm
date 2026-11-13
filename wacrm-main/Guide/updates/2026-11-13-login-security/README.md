# Safer sign-in: two-step verification, devices and account lock

Sign-in now records every attempt, locks an account after repeated wrong passwords, asks administrators for an authenticator code, and lets you see and sign out each device.

## What changed

- **Everyone signs in once more.** Sign-ins from before this update stop working, so every session is created under the new rules.
- **Account lock.** 5 wrong passwords (or wrong codes) in a row lock the account for 15 minutes. The sign-in page says how long is left.
- **Two-step verification.** Super admin, Admin 1 and Admin 2 must use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and similar). Everyone else can turn it on in Settings.
- **Recovery codes.** When you turn on two-step verification you get 10 one-time recovery codes. Each code signs you in once if you lose your phone.
- **Signed-in devices.** Settings → Login & security lists every browser or device signed in to your account. Sign out one device, or **Sign out everywhere** with a reason.
- **Temporary passwords.** An administrator can issue a temporary password from Settings → Subscription users. It works for 72 hours and must be changed at the next sign-in.
- **Session length.** A sign-in lasts 7 days. A Super admin is signed out after 30 minutes without activity.
- **Password change and reset** sign out your other devices.
- Every sign-in attempt, lock, device sign-out, two-step change and password change is recorded for the user management audit trail.

## Who it affects

- Roles: everyone. Two-step verification is required for Super admin, Admin 1 and Admin 2.
- Tabs: sign-in page, Settings → Login & security, Settings → Subscription users.

## How to use it

1. Sign in as usual. If you are an administrator without two-step verification, the CRM opens **Set up two-step verification**.
2. Click **Start set-up**, add the set-up key to your authenticator app, type the 6-digit code and click **Verify and turn on**.
3. Copy or download the recovery codes, then click **I have saved my recovery codes**.
4. Next time, after your password the sign-in page asks for the 6-digit code. Lost your phone? Click **Use a recovery code**.
5. To issue a temporary password: Settings → Subscription users → open the user → **Issue temporary password**. Copy it and give it to the user; it is shown only once.

## Related guide chapters updated

- 01 Getting started (Signing in)
- 11 Settings (Login & security, Subscription users)
- 13 FAQ & troubleshooting (Account)

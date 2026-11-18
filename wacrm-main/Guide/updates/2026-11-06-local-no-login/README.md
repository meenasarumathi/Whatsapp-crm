# Open the CRM without signing in on your own computer

A local switch skips the sign-in page and opens the Dashboard directly.

## What changed

- With `AUTH_BYPASS_USER_ID` set in `.env.local`, opening the CRM on `localhost` signs you in automatically as that user.
- Sign out returns you to the Dashboard while the switch is on.
- Tunnels, real domains and production servers still ask for a normal sign-in.

## Who it affects

- Roles: whichever role the chosen user has
- Tabs: Sign in, Dashboard

## How to use it

1. To turn it on, add `AUTH_BYPASS_USER_ID=<user id>` to `.env.local`.
2. To bring the sign-in page back, delete that line.

## Related guide chapters updated

- Getting started

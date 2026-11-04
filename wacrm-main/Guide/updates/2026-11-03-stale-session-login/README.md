# Sign-in page reachable after a password reset

An old sign-in left over from before a password reset no longer traps you on a blank dashboard; you now land on the sign-in form.

## What changed

- When the app finds a sign-in that is no longer valid (password reset, sign out everywhere), it clears it automatically.
- Before, the browser bounced between the dashboard and the sign-in page and showed a blank screen.
- Local installs on plain http: set AUTH_COOKIE_SECURE=false in .env.local so the sign-in cookie is kept.

## Who it affects

- Roles: Owner / Admin / Agent / Viewer
- Tabs: Sign-in, Dashboard

## How to use it

1. Open the sign-in page.
2. Sign in with your email and new password.

## Related guide chapters updated

- 13 FAQ and troubleshooting (Account)

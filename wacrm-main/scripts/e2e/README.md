# End-to-end suites

Plain Node scripts that drive a running server and its database.

```bash
npm run build && PORT=3100 npm start &       # with DATABASE_URL, AUTH_SECRET, ENCRYPTION_KEY, META_APP_SECRET set
BASE=http://localhost:3100 MAIL_LOG=server.log node scripts/e2e/core.mjs      # auth, sessions, /api/db, RLS, storage
BASE=http://localhost:3100 node scripts/e2e/modules.mjs                       # CRUD per module, realtime
BASE=http://localhost:3100 node scripts/e2e/webhook.mjs                       # signed WhatsApp webhook
```

`MAIL_LOG` is the server log file where password-reset links are written when SMTP is not configured.
Use a throwaway database: the suites create users and data.

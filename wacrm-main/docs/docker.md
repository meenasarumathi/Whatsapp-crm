# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with two
services, `postgres` and `app`. PostgreSQL (`pgvector/pgvector:pg16`) listens on
host port **5433** (database `wacrm`, user `postgres`, password
`strong_password` — change it for anything but local use), stores data in the
`wacrm_pgdata` volume, has a `pg_isready` health check, and applies
`db/schema.sql` the first time the volume is created. The app waits for the
database to be healthy.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`. This includes
  `NEXT_PUBLIC_APP_LOCALE` (`en | ko | pt | es`), so the UI language is
  fixed per image.
- Everything else (`AUTH_SECRET`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 \
  -v wacrm_uploads:/data/uploads -e UPLOAD_DIR=/data/uploads wacrm
```

## Notes

- The schema is applied by the Postgres container on first start only.
  For an already-running server (for example a container that is already
  using port 5433) run `npm run db:init` instead. It is safe to repeat: one transaction, nothing is dropped, objects that
  already exist are kept, and an unchanged schema is skipped (`--force` re-applies it to repair missing parts).
  `docker compose up -d postgres` alone starts just the database for local
  development with `npm run dev`.
- Uploads (avatars, chat media, flow media) are stored in the
  `wacrm_uploads` volume — include it in backups together with
  `wacrm_pgdata`.
- Received attachments are copied into the `chat-media` bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching disk usage. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. If you use automation
  Wait steps or flows, point an external scheduler at
  `GET /api/automations/cron` and `GET /api/flows/cron` on this
  deployment, sending the shared secret in the `x-cron-secret` header
  (`AUTOMATION_CRON_SECRET`, see `.env.local.example`). Both return
  503 until that variable is set.

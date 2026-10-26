# db:init works on the pgvector Docker database

`npm run db:init` no longer rolls back on the Docker Postgres (pgvector image) because of the AI knowledge embedding column.

## What changed

- The schema check accepts `ai_knowledge_chunks.embedding` as `vector(1536)` (pgvector installed) as well as `real[]` (no pgvector). Before, a fresh Docker database failed with "after repair the database still differs from the schema".

## Who it affects

- Roles: Owner (whoever installs or hosts WACRM)
- Tabs: none - setup only

## How to use it

1. Check `DATABASE_URL` in `.env.local` points at the database you look at in pgAdmin (Docker: port 5433, native Postgres: port 5432).
2. Run `npm run db:init`, then restart `npm run dev` so the app picks up the new connection.
3. Users are stored in the `public.users` table (login, password hash); name and account are in `public.profiles`. The old `auth.users` table is not used any more.

## Related guide chapters updated

- none

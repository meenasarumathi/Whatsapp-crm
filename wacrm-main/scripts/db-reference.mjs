// Regenerates db/schema-reference.json from a database built from a CLEAN db/schema.sql
// (maintainers only - run after changing db/schema.sql):
//   createdb wacrm_ref && DATABASE_URL=postgres://.../wacrm_ref npm run db:init
//   DATABASE_URL=postgres://.../wacrm_ref node scripts/db-reference.mjs
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { readCatalog } from "./lib/catalog.mjs";
for (const f of [".env.local", ".env"]) if (existsSync(f)) { try { process.loadEnvFile(f); } catch {} }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const cat = await readCatalog(c);
cat.schemaChecksum = createHash("sha256").update(readFileSync("db/schema.sql")).digest("hex");
writeFileSync("db/schema-reference.json", JSON.stringify(cat, null, 1) + "\n");
console.log(`wrote db/schema-reference.json: ${Object.keys(cat.tables).length} tables, ${Object.keys(cat.constraints).length} constraints, ${Object.keys(cat.indexes).length} indexes, ${Object.keys(cat.functions).length} functions`);
await c.end();

// Shared helpers for the export and validate scripts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const target = JSON.parse(readFileSync(new URL("./target-columns.json", import.meta.url), "utf8"));

export const MODULES = [
  ["Accounts & team", ["users", "accounts", "profiles", "account_invitations", "member_presence", "password_reset_tokens"]],
  ["Subscriptions", ["platform_users"]],
  ["WhatsApp setup", ["whatsapp_config", "message_templates"]],
  ["Contacts", ["contacts", "tags", "contact_tags", "custom_fields", "contact_custom_values", "contact_notes"]],
  ["Inbox", ["conversations", "messages", "message_reactions", "quick_replies"]],
  ["Pipelines", ["pipelines", "pipeline_stages", "deals"]],
  ["Broadcasts", ["broadcasts", "broadcast_recipients"]],
  ["Automations", ["automations", "automation_steps", "automation_logs", "automation_pending_executions"]],
  ["Flows", ["flows", "flow_nodes", "flow_runs", "flow_run_events"]],
  ["AI & Train AI", ["ai_configs", "ai_knowledge_documents", "ai_knowledge_chunks", "ai_usage_log", "ai_training_profiles", "ai_training_examples"]],
  ["Public API & webhooks", ["api_keys", "webhook_endpoints"]],
  ["Notifications", ["notifications"]],
  ["Database admin", ["db_maintenance_log"]],
];
export const moduleOf = (table) => MODULES.find(([, ts]) => ts.includes(table))?.[0] ?? "Other";

/** Old hosted login table -> new users table. [target column, source expression] */
export const USERS_MAP = [
  ["id", "id"],
  ["email", "email"],
  ["password_hash", "encrypted_password"],
  ["raw_user_meta_data", "raw_user_meta_data"],
  ["email_confirmed_at", "email_confirmed_at"],
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
  ["last_sign_in_at", "last_sign_in_at"],
];

export const q = (ident) => '"' + String(ident).replace(/"/g, '""') + '"';

/** SQL literal for a value that has been rendered as text by the server. */
export function literal(text, type) {
  if (text === null || text === undefined) return "NULL";
  return `'${String(text).replace(/'/g, "''")}'::${type}`;
}

/** Order-independent table checksum: sum of per-row sha256 (mod 2^256). */
export class TableHash {
  sum = 0n;
  count = 0;
  add(values) {
    const h = createHash("sha256");
    for (const v of values) {
      h.update(v === null || v === undefined ? "\u0000N" : "\u0000V" + v);
      h.update("\u001f");
    }
    this.sum = (this.sum + BigInt("0x" + h.digest("hex"))) & ((1n << 256n) - 1n);
    this.count++;
  }
  hex() {
    return this.sum.toString(16).padStart(64, "0");
  }
}

export function connectionOptions(url) {
  const local = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url) || process.env.PGSSLMODE === "disable";
  return local ? { connectionString: url } : { connectionString: url, ssl: { rejectUnauthorized: false } };
}

/** Text the server should produce for a column: cast to the NEW column type first. */
export function selectExpr(col, srcName = col.name) {
  return `${q(srcName)}::${col.type}::text AS ${q(col.name)}`;
}

export const SESSION_SETUP = [
  "SET TIME ZONE 'UTC'",
  "SET DateStyle = 'ISO, MDY'",
  "SET IntervalStyle = 'postgres'",
  "SET bytea_output = 'hex'",
  "SET extra_float_digits = 1",
];

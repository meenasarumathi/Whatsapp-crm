// ============================================================
// Database backup — which tables go into a backup, and how rows are
// cleaned before they leave the server. Pure; no I/O.
//
// Two scopes (see /api/backup):
//   account — everything the caller's account owns, read through the
//             caller's own RLS-scoped session (Owner / Admin).
//   full    — every table, every account, via the service role
//             (Super admin only).
//
// Secrets never leave the server: API keys, access tokens, signing
// secrets and invite token hashes are replaced with "[redacted]", and
// bulky AI embedding vectors are dropped (they're rebuilt from the
// text by re-indexing the knowledge base).
// ============================================================

export type BackupScope = "account" | "full";

export interface BackupTable {
  name: string;
  /** Column used to page through rows in a stable order. */
  orderBy: string;
  /** Only included in a full (all-accounts) backup. */
  fullOnly?: boolean;
}

/** Tables in a sensible restore order: parents before children. */
export const BACKUP_TABLES: BackupTable[] = [
  { name: "accounts", orderBy: "id" },
  { name: "profiles", orderBy: "id" },
  { name: "platform_users", orderBy: "user_id", fullOnly: true },
  { name: "account_invitations", orderBy: "id" },
  { name: "tags", orderBy: "id" },
  { name: "custom_fields", orderBy: "id" },
  { name: "contacts", orderBy: "id" },
  { name: "contact_tags", orderBy: "id" },
  { name: "contact_custom_values", orderBy: "id" },
  { name: "contact_notes", orderBy: "id" },
  { name: "conversations", orderBy: "id" },
  { name: "messages", orderBy: "id" },
  { name: "message_reactions", orderBy: "id" },
  { name: "message_templates", orderBy: "id" },
  { name: "quick_replies", orderBy: "id" },
  { name: "pipelines", orderBy: "id" },
  { name: "pipeline_stages", orderBy: "id" },
  { name: "deals", orderBy: "id" },
  { name: "broadcasts", orderBy: "id" },
  { name: "broadcast_recipients", orderBy: "id" },
  { name: "automations", orderBy: "id" },
  { name: "automation_steps", orderBy: "id" },
  { name: "automation_logs", orderBy: "id" },
  { name: "automation_pending_executions", orderBy: "id" },
  { name: "flows", orderBy: "id" },
  { name: "flow_nodes", orderBy: "id" },
  { name: "flow_runs", orderBy: "id" },
  { name: "flow_run_events", orderBy: "id" },
  { name: "notifications", orderBy: "id" },
  { name: "whatsapp_config", orderBy: "id" },
  { name: "webhook_endpoints", orderBy: "id" },
  { name: "api_keys", orderBy: "id" },
  { name: "ai_configs", orderBy: "id" },
  { name: "ai_knowledge_documents", orderBy: "id" },
  { name: "ai_knowledge_chunks", orderBy: "id" },
  { name: "ai_training_profiles", orderBy: "id" },
  { name: "ai_training_examples", orderBy: "id" },
  { name: "ai_usage_log", orderBy: "id" },
];

export function tablesFor(scope: BackupScope): BackupTable[] {
  return BACKUP_TABLES.filter((t) => scope === "full" || !t.fullOnly);
}

/** Columns whose values are secrets, per table. */
const REDACT: Record<string, string[]> = {
  whatsapp_config: ["access_token", "verify_token", "app_secret"],
  ai_configs: ["api_key", "embeddings_api_key"],
  api_keys: ["key_hash"],
  webhook_endpoints: ["secret"],
  account_invitations: ["token_hash"],
};

/** Columns dropped entirely (large and derivable). */
const DROP: Record<string, string[]> = {
  ai_knowledge_chunks: ["embedding"],
};

export const REDACTED = "[redacted]";

export function cleanRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...row };
  for (const col of DROP[table] ?? []) delete out[col];
  for (const col of REDACT[table] ?? []) {
    if (out[col] != null && out[col] !== "") out[col] = REDACTED;
  }
  return out;
}

export interface BackupFile {
  format: "wacrm-backup";
  version: 1;
  created_at: string;
  scope: BackupScope;
  account: { id: string; name: string } | null;
  created_by: string | null;
  /** Row count per table. */
  counts: Record<string, number>;
  /** Tables that couldn't be read (missing, or no access), with the reason. */
  skipped: Record<string, string>;
  /** True if a table hit the per-table row cap. */
  truncated: string[];
  notes: string[];
  tables: Record<string, Record<string, unknown>[]>;
}

/** e.g. "wacrm-backup-acme-2026-10-10-1432.json" */
export function backupFileName(scope: BackupScope, accountName: string | null, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const who =
    scope === "full"
      ? "full"
      : (accountName ?? "account")
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30) || "account";
  return `wacrm-backup-${who}-${stamp}.json`;
}

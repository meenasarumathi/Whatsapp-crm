// Every embedded select used by the application must be understood by the query builder
// (and produce valid SQL). Runs against a PostgreSQL with db/schema.sql applied;
// skipped when TEST_DATABASE_URL is not set.
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const SELECTS: Array<[string, string]> = [
  ["automation_logs", "*, contact:contacts(id, name, phone)"],
  ["automation_logs", "id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)"],
  ["broadcast_recipients", "*, contact:contacts(*)"],
  ["messages", "conversation_id, conversations(account_id)"],
  ["broadcast_recipients", "id, status, broadcast_id, broadcasts!inner(account_id)"],
  ["broadcast_recipients", "id, template_params, contact:contacts(phone)"],
  ["contact_tags", "id, tag_id, tags(*)"],
  ["conversations", "*, contact:contacts(*)"],
  ["conversations", "contact:contacts(name, wa_username, phone)"],
  ["conversations", "id, account_id, contact:contacts(phone, wa_user_id)"],
  ["conversations", "id, last_message_text, last_message_at, contact:contacts(name, phone)"],
  ["deals", "*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)"],
  ["deals", "*, stage:pipeline_stages(*)"],
  ["deals", "id, title, updated_at, stage:pipeline_stages(name)"],
  ["flow_runs", "id, flow_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )"],
  ["flow_runs", "id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, vars, reprompt_count, contact:contacts(id, name, phone)"],
  ["messages", "id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))"],
  ["flow_runs", "id, flow_id, flows(fallback_policy)"],
  ["profiles", "user_id, account:accounts(name)"],
];

d("embedded selects used by the app", () => {
  afterAll(async () => {
    const pool = await import("./pool");
    await pool.closePool();
  });
  for (const [table, select] of SELECTS) {
    it(`${table}: ${select.slice(0, 70)}`, async () => {
      process.env.DATABASE_URL = url;
      const { createServiceDb } = await import("./client");
      const r = await createServiceDb().from(table).select(select).limit(1);
      expect(r.error, JSON.stringify(r.error)).toBeNull();
    });
  }
});

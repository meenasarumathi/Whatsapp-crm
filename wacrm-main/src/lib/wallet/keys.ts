// ============================================================
// Logical message keys for message_charges.message_id (PLAN.md §3).
//
// A key names ONE automated message. Retries of that message must
// produce the same key so they reuse the charge row (one charge, one
// send). Where an engine has a stable id for the message we use it;
// where duplicates are already stopped upstream (duplicate Meta
// webhooks are dropped before any engine runs) a fresh id is safe.
// ============================================================

function fresh(): string {
  return globalThis.crypto.randomUUID();
}

/** AI auto-reply to one inbound customer message. */
export function aiMessageKey(inboundWamid: string | null | undefined): string {
  return inboundWamid ? `ai:${inboundWamid}` : `ai:${fresh()}`;
}

/** One automation step within one automation run (log). */
export function automationMessageKey(logId: string | null, stepId: string): string {
  return logId ? `auto:${logId}:${stepId}` : `auto:${fresh()}:${stepId}`;
}

/** One message a flow node sends (nodes can repeat within a run, so a fresh suffix). */
export function flowMessageKey(runId: string, nodeKey: string): string {
  return `flow:${runId}:${nodeKey}:${fresh()}`;
}

/** One broadcast recipient — shared by the wizard, the API and Resume. */
export function broadcastMessageKey(recipientRowId: string): string {
  return `bc:${recipientRowId}`;
}

/** Public-API send; callers can pass an Idempotency-Key to make retries safe. */
export function apiMessageKey(accountId: string, idempotencyKey: string | null | undefined): string {
  const k = idempotencyKey?.trim();
  return k && /^[\w.:-]{1,100}$/.test(k) ? `api:${accountId}:${k}` : `api:${fresh()}`;
}

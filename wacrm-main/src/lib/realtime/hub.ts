// ============================================================
// Realtime hub — one Postgres LISTEN connection per server process.
// Triggers (db/schema.sql §8) NOTIFY a small {table, op, id, account_id}
// message on every change to the live tables; the SSE endpoint turns each into
// an event for each connected browser, after re-checking Row Level Security
// for that browser's user.
// ============================================================

import { Client } from "pg";
import { EventEmitter } from "node:events";

import { connectionString } from "@/lib/db/pool";

export interface ChangeNotice {
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  id: string | null;
  account_id: string | null;
  user_id: string | null;
  conversation_id: string | null;
}

const CHANNEL = "wacrm_changes";

interface HubState {
  emitter: EventEmitter;
  client: Client | null;
  starting: boolean;
}

const g = globalThis as unknown as { __wacrmHub?: HubState };

function state(): HubState {
  if (!g.__wacrmHub) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    g.__wacrmHub = { emitter, client: null, starting: false };
  }
  return g.__wacrmHub;
}

async function connect(): Promise<void> {
  const s = state();
  if (s.client || s.starting) return;
  s.starting = true;
  try {
    const client = new Client({ connectionString: connectionString() });
    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        s.emitter.emit("change", JSON.parse(msg.payload) as ChangeNotice);
      } catch {
        /* ignore malformed payloads */
      }
    });
    const drop = () => {
      if (s.client === client) s.client = null;
      client.end().catch(() => {});
      if (s.emitter.listenerCount("change") > 0) setTimeout(() => void connect(), 2000);
    };
    client.on("error", drop);
    client.on("end", drop);
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    s.client = client;
  } catch {
    setTimeout(() => void connect(), 2000);
  } finally {
    s.starting = false;
  }
}

/** Subscribe to every change notice. Returns an unsubscribe function. */
export function onChange(handler: (n: ChangeNotice) => void): () => void {
  const s = state();
  s.emitter.on("change", handler);
  void connect();
  return () => {
    s.emitter.off("change", handler);
  };
}

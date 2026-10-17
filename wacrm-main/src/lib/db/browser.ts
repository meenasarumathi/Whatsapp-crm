"use client";
// ============================================================
// Browser data client. Records the same chain used on the server
// (db.from("t").select(...).eq(...)) and sends it to POST /api/db, where it is
// replayed under the signed-in user's Row Level Security.
// ============================================================

import type { DbResponse } from "./types";
import type { QueryBuilder, RpcBuilder } from "./builder";
import { createRealtimeClient, type RealtimeChannelApi } from "./realtime-client";
import { createAuthClient, type BrowserAuth } from "@/lib/auth/browser";
import { createStorageClient, type BrowserStorage } from "@/lib/storage/browser";

type Call = [string, ...unknown[]];

async function post(body: unknown): Promise<DbResponse> {
  try {
    const res = await fetch("/api/db", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const json = (await res.json()) as DbResponse;
    return json;
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : "Network error", code: "NETWORK", details: null, hint: null }, count: null } as DbResponse;
  }
}

/** A recorder: any method call is appended; awaiting it sends the request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recorder(make: (ops: Call[]) => unknown): any {
  const ops: Call[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target: any = {
    then(onOk: (v: DbResponse) => unknown, onErr?: (e: unknown) => unknown) {
      return (post(make(ops)) as Promise<DbResponse>).then(onOk, onErr);
    },
    throwOnError() { return proxy; },
    returns() { return proxy; },
    abortSignal() { return proxy; },
  };
  const proxy: unknown = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => { ops.push([prop, ...args]); return proxy; };
    },
  });
  return proxy;
}

export interface BrowserDb {
  from(table: string): QueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>): RpcBuilder;
  auth: BrowserAuth;
  storage: BrowserStorage;
  channel(name: string, opts?: unknown): RealtimeChannelApi;
  removeChannel(channel: RealtimeChannelApi): Promise<"ok">;
}

let instance: BrowserDb | null = null;

/**
 * One shared client per browser tab. Components list it in hook dependency
 * arrays, so it must keep the same identity between renders.
 */
export function createBrowserDb(): BrowserDb {
  if (instance) return instance;
  const rt = createRealtimeClient();
  instance = {
    from: (table) => recorder((ops) => ({ kind: "query", table, ops })) as QueryBuilder,
    rpc: (fn, args = {}) => recorder((ops) => ({ kind: "rpc", fn, args, ops })) as RpcBuilder,
    auth: createAuthClient(),
    storage: createStorageClient(),
    channel: (name, opts) => rt.channel(name, opts),
    removeChannel: (ch) => rt.removeChannel(ch),
  };
  return instance;
}

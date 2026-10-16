"use client";
// ============================================================
// Browser side of the live-update feed (GET /api/realtime, server-sent events).
// Offers channel(...).on("postgres_changes", {event, table, filter}, cb).subscribe(cb)
// so hooks keep their shape. One EventSource is shared by every channel.
// ============================================================

export interface ChangePayload {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  schema: "public";
  table: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  old: Record<string, any>;
}

interface Binding {
  event: "INSERT" | "UPDATE" | "DELETE" | "*";
  table: string;
  filter: { column: string; value: string } | null;
  cb: (payload: ChangePayload) => void;
}

type Status = "SUBSCRIBED" | "CHANNEL_ERROR" | "CLOSED";

export interface RealtimeChannelApi {
  on(
    type: "postgres_changes",
    filter: { event: string; schema?: string; table: string; filter?: string },
    cb: (payload: ChangePayload) => void,
  ): RealtimeChannelApi;
  subscribe(cb?: (status: Status) => void): RealtimeChannelApi;
  unsubscribe(): void;
}

class Channel implements RealtimeChannelApi {
  bindings: Binding[] = [];
  statusCb?: (s: Status) => void;
  constructor(private readonly hub: Hub, readonly name: string) {}
  on(_type: "postgres_changes", f: { event: string; table: string; filter?: string }, cb: (p: ChangePayload) => void) {
    let filter: Binding["filter"] = null;
    const m = f.filter?.match(/^([a-z_]+)=eq\.(.*)$/);
    if (m) filter = { column: m[1], value: m[2] };
    this.bindings.push({ event: f.event as Binding["event"], table: f.table, filter, cb });
    return this;
  }
  subscribe(cb?: (s: Status) => void) {
    this.statusCb = cb;
    this.hub.add(this);
    return this;
  }
  unsubscribe() {
    this.hub.remove(this);
  }
}

class Hub {
  private channels = new Set<Channel>();
  private source: EventSource | null = null;
  private open = false;

  channel(name: string): RealtimeChannelApi {
    return new Channel(this, name);
  }

  add(ch: Channel) {
    this.channels.add(ch);
    if (typeof EventSource === "undefined") return;
    if (!this.source) this.connect();
    else if (this.open) queueMicrotask(() => ch.statusCb?.("SUBSCRIBED"));
  }

  remove(ch: Channel) {
    if (!this.channels.delete(ch)) return;
    ch.statusCb?.("CLOSED");
    if (this.channels.size === 0 && this.source) {
      this.source.close();
      this.source = null;
      this.open = false;
    }
  }

  async removeChannel(ch: RealtimeChannelApi): Promise<"ok"> {
    ch.unsubscribe();
    return "ok";
  }

  private notify(s: Status) {
    for (const ch of this.channels) ch.statusCb?.(s);
  }

  private connect() {
    const es = new EventSource("/api/realtime");
    this.source = es;
    es.onmessage = (ev) => {
      let msg: { type?: string; table?: string; eventType?: ChangePayload["eventType"]; new?: Record<string, unknown>; old?: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.open = true;
        this.notify("SUBSCRIBED");
        return;
      }
      if (!msg.table || !msg.eventType) return;
      const payload: ChangePayload = { eventType: msg.eventType, schema: "public", table: msg.table, new: msg.new ?? {}, old: msg.old ?? {} };
      const row = msg.eventType === "DELETE" ? payload.old : payload.new;
      for (const ch of [...this.channels]) {
        for (const b of ch.bindings) {
          if (b.table !== payload.table) continue;
          if (b.event !== "*" && b.event !== payload.eventType) continue;
          if (b.filter && String(row[b.filter.column] ?? "") !== b.filter.value) continue;
          try {
            b.cb(payload);
          } catch (e) {
            console.error("[realtime] handler error:", e);
          }
        }
      }
    };
    es.onerror = () => {
      this.open = false;
      this.notify("CHANNEL_ERROR");
      // A 401 closes the stream for good; otherwise EventSource retries by itself.
      if (es.readyState === EventSource.CLOSED) {
        this.source = null;
        if (this.channels.size > 0) setTimeout(() => !this.source && this.channels.size > 0 && this.connect(), 5000);
      }
    };
  }
}

export function createRealtimeClient() {
  const hub = new Hub();
  return {
    channel: (name: string, _opts?: unknown) => hub.channel(name),
    removeChannel: (ch: RealtimeChannelApi) => hub.removeChannel(ch),
  };
}

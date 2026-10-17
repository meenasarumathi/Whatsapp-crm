import { getSessionUserId } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/client";
import { onChange, type ChangeNotice } from "@/lib/realtime/hub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLES = new Set([
  "messages", "conversations", "message_reactions", "flow_runs", "member_presence", "notifications",
]);

/**
 * Server-sent events. For every change in the live tables the signed-in user
 * is allowed to see, emits  data: {table, eventType, new, old}.
 * Visibility is decided by Row Level Security: INSERT/UPDATE re-read the row as
 * the user; DELETE is delivered when the user is a member of the row's account.
 */
export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };
      controller.enqueue(encoder.encode(`retry: 3000\n: connected\n\n`));
      send({ type: "ready" });

      const memberCache = new Map<string, boolean>();
      const isMember = async (accountId: string): Promise<boolean> => {
        const hit = memberCache.get(accountId);
        if (hit !== undefined) return hit;
        const ok = await withUserTransaction(userId, async (exec) => {
          const r = await exec("SELECT public.is_account_member($1::uuid) AS ok", [accountId]);
          return r.rows[0]?.ok === true;
        });
        memberCache.set(accountId, ok);
        return ok;
      };

      // Events are handled in arrival order so INSERT precedes UPDATE for a row.
      let chain: Promise<void> = Promise.resolve();
      const handle = async (n: ChangeNotice) => {
        if (!TABLES.has(n.table) || !n.account_id) return;
        try {
          if (n.op === "DELETE") {
            if (!(await isMember(n.account_id))) return;
            const old: Record<string, unknown> = { account_id: n.account_id, user_id: n.user_id, conversation_id: n.conversation_id };
            if (n.table === "member_presence") old.user_id = n.id;
            else old.id = n.id;
            send({ table: n.table, eventType: "DELETE", new: {}, old });
            return;
          }
          const key = n.table === "member_presence" ? "user_id" : "id";
          const row = await withUserTransaction(userId, async (exec) => {
            const r = await exec(`SELECT * FROM public.${n.table} WHERE ${key} = $1`, [n.id]);
            return r.rows[0] ?? null;
          });
          if (row) send({ table: n.table, eventType: n.op, new: row, old: {} });
        } catch (e) {
          console.error("[realtime] dispatch failed:", e instanceof Error ? e.message : e);
        }
      };
      const unsubscribe = onChange((n) => {
        chain = chain.then(() => handle(n));
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 25_000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

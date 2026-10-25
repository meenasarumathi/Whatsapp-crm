/**
 * 12. Every outgoing-send path from docs/token-wallet/PLAN.md §2 is
 * either charged or deliberately exempt — and a NEW path fails this
 * test until someone classifies it.
 *
 * Two layers:
 *   - Inventory: every non-test source file that calls a Meta send
 *     function must appear in PATHS. Charged files must route the call
 *     through `sendWithCharge`.
 *   - Call sites: each engine names the right source on every send, and
 *     the manual inbox route passes no charge.
 * Behaviour of the charged senders (blocked → provider never called) is
 * covered by the engine-sender tests below and by charge.test.ts.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SRC = join(process.cwd(), "src");
const PROVIDER_CALL =
  /\b(sendTextMessage|sendMediaMessage|sendTemplateMessage|sendInteractiveButtons|sendInteractiveList|sendReactionMessage|sendTypingIndicator)\(/;

/** Phase 1 table: file → charged or exempt (with the reason). */
const PATHS: Record<string, { charged: boolean; why: string }> = {
  "src/lib/flows/meta-send.ts": { charged: true, why: "chatbot flows, AI auto-reply text, automation buttons/lists" },
  "src/lib/automations/meta-send.ts": { charged: true, why: "automation send_message / send_template (incl. scheduled)" },
  "src/lib/whatsapp/broadcast-core.ts": { charged: true, why: "API broadcasts and Resume, per recipient" },
  "src/app/api/whatsapp/broadcast/route.ts": { charged: true, why: "dashboard broadcast wizard, per recipient" },
  "src/lib/whatsapp/send-message.ts": { charged: true, why: "charged only when a caller passes a charge (public API); inbox replies pass none" },
  "src/app/api/whatsapp/react/route.ts": { charged: false, why: "manual reaction by an agent" },
  "src/lib/ai/auto-reply.ts": { charged: false, why: "typing indicator only — not a message; the reply itself is charged via flows/meta-send" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("12. send-path inventory", () => {
  const callers = walk(SRC)
    .filter((f) => !f.endsWith("lib/whatsapp/meta-api.ts"))
    .filter((f) => PROVIDER_CALL.test(readFileSync(f, "utf8")))
    .map((f) => relative(process.cwd(), f));

  it("every file that calls the WhatsApp provider is classified", () => {
    const unclassified = callers.filter((f) => !(f in PATHS));
    expect(unclassified, "classify these send paths in PATHS and PLAN.md").toEqual([]);
  });

  it.each(Object.entries(PATHS).filter(([, v]) => v.charged))(
    "%s routes provider calls through sendWithCharge",
    (file) => {
      expect(read(file)).toMatch(/sendWithCharge\(/);
    },
  );

  it("the AI auto-reply only calls the typing indicator directly", () => {
    const src = read("src/lib/ai/auto-reply.ts");
    const direct = src.match(new RegExp(PROVIDER_CALL.source, "g")) ?? [];
    expect(direct.every((m) => m.startsWith("sendTypingIndicator"))).toBe(true);
  });
});

describe("12. each engine charges under the right source", () => {
  const sources = (file: string) =>
    [...read(file).matchAll(/source:\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);

  it("flows (chatbot): every engine send declares source chatbot", () => {
    const src = read("src/lib/flows/engine.ts");
    const sends = src.match(/await engineSend\w+\(\{/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(6);
    expect(sources("src/lib/flows/engine.ts")).toEqual(Array(sends.length).fill("chatbot"));
  });

  it("automations (workflow, incl. scheduled steps): source workflow on every send", () => {
    const src = read("src/lib/automations/engine.ts");
    const sends = src.match(/await engineSend\w+\(\{/g) ?? [];
    expect(sends.length).toBe(3);
    expect(sources("src/lib/automations/engine.ts")).toEqual(["workflow", "workflow", "workflow"]);
  });

  it("AI auto-reply: source ai_agent, keyed on the inbound wamid", () => {
    expect(sources("src/lib/ai/auto-reply.ts")).toEqual(["ai_agent"]);
    expect(read("src/lib/ai/auto-reply.ts")).toMatch(/aiMessageKey\(inboundMessageId\)/);
  });

  it("broadcasts: source broadcast, keyed on the recipient row", () => {
    expect(sources("src/lib/whatsapp/broadcast-core.ts")).toEqual(["broadcast"]);
    expect(sources("src/app/api/whatsapp/broadcast/route.ts")).toEqual(["broadcast"]);
    expect(read("src/lib/whatsapp/broadcast-core.ts")).toMatch(/broadcastMessageKey\(recipient\.recipientRowId\)/);
  });

  it("public API: source api", () => {
    expect(sources("src/app/api/v1/messages/route.ts")).toEqual(["api"]);
  });

  it("inbox agent replies (manual) pass no charge — free, even at zero balance", () => {
    const route = read("src/app/api/whatsapp/send/route.ts");
    expect(route).toMatch(/sendMessageToConversation\(/);
    expect(route).not.toMatch(/charge/);
  });
});

// ---------------------------------------------------------------------------
// Behaviour: the flows sender (used by chatbot flows, the AI reply and
// automation buttons/lists) never reaches Meta when the wallet refuses.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => ({ messageId: "wamid.out" })),
  sendWithCharge: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: () => "token" }));
vi.mock("@/lib/wallet/charge", () => ({ sendWithCharge: h.sendWithCharge }));
vi.mock("@/lib/flows/admin-client", () => ({
  serviceDb: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ["select", "eq", "update"]) b[m] = vi.fn(chain);
      const row =
        table === "contacts"
          ? { id: "c1", phone: "+15551234567", wa_user_id: null }
          : table === "whatsapp_config"
            ? { phone_number_id: "PN", access_token: "enc" }
            : null;
      b.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
      b.single = vi.fn(async () => ({ data: row, error: null }));
      b.insert = vi.fn(async (r: Record<string, unknown>) => {
        h.inserts.push(r);
        return { error: null };
      });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));

import { engineSendText } from "@/lib/flows/meta-send";

describe("12. charged sender behaviour (flows/meta-send)", () => {
  const args = {
    accountId: "acct",
    userId: "u",
    conversationId: "conv",
    contactId: "c1",
    text: "Hi",
    charge: { source: "chatbot" as const, messageKey: "flow:r:n:1" },
  };

  beforeEach(() => {
    h.inserts.length = 0;
    h.sendTextMessage.mockClear();
  });

  it("charges, then sends once and stores the message", async () => {
    h.sendWithCharge.mockImplementation(async ({ send }: { send: () => Promise<string> }) => send());
    await expect(engineSendText(args)).resolves.toEqual({ whatsapp_message_id: "wamid.out" });
    expect(h.sendWithCharge).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct", charge: args.charge }),
    );
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.inserts).toHaveLength(1);
  });

  it("blocked by the wallet: Meta is never called and nothing is stored", async () => {
    h.sendWithCharge.mockRejectedValue(Object.assign(new Error("insufficient_tokens"), { reason: "insufficient_tokens" }));
    await expect(engineSendText(args)).rejects.toThrow("insufficient_tokens");
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.inserts).toHaveLength(0);
  });
});

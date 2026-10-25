import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";

// 6 / 12. Broadcast delivery is charged per recipient and stops sending
// (without calling Meta) once the wallet is empty.

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: "wamid.b" })),
  sendWithCharge: vi.fn(),
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({ sendTemplateMessage: h.sendTemplateMessage }));
vi.mock("@/lib/wallet/charge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/wallet/charge")>("@/lib/wallet/charge");
  return { ...actual, sendWithCharge: h.sendWithCharge };
});

import { deliverBroadcast, type BroadcastPlan } from "./broadcast-core";
import { AutomatedSendBlockedError } from "@/lib/wallet/charge";

function fakeDb(): DbClient {
  return {
    from: () => {
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.update = (p: Record<string, unknown>) => {
        patch = p;
        return b;
      };
      b.eq = (_c: string, id: string) => {
        if (Object.keys(patch).length) h.updates.push({ id, patch });
        return b;
      };
      b.select = () => b;
      b.in = () => b;
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return b;
    },
  } as unknown as DbClient;
}

const plan = (n: number): BroadcastPlan => ({
  accountId: "acct",
  broadcastId: "b1",
  templateName: "promo",
  templateLanguage: "en_US",
  phoneNumberId: "PN",
  accessToken: "tok",
  templateRow: null,
  planned: Array.from({ length: n }, (_, i) => ({ recipientRowId: `r${i}`, phone: `+1555000000${i}`, params: [] })),
  rejected: 0,
});

describe("broadcast delivery and the token wallet", () => {
  beforeEach(() => {
    h.updates.length = 0;
    h.sendTemplateMessage.mockClear();
    h.sendWithCharge.mockReset();
  });

  it("charges each recipient under its own row key", async () => {
    h.sendWithCharge.mockImplementation(async ({ send }: { send: () => Promise<string> }) => send());
    await deliverBroadcast(fakeDb(), plan(3));
    expect(h.sendWithCharge.mock.calls.map((c) => c[0].charge)).toEqual([
      { source: "broadcast", messageKey: "bc:r0" },
      { source: "broadcast", messageKey: "bc:r1" },
      { source: "broadcast", messageKey: "bc:r2" },
    ]);
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(3);
  });

  it("zero balance: nothing is sent and recipients are marked insufficient_tokens", async () => {
    h.sendWithCharge.mockRejectedValue(new AutomatedSendBlockedError("insufficient_tokens"));
    await deliverBroadcast(fakeDb(), plan(4));
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    // Only the first recipient asks the wallet; the rest short-circuit.
    expect(h.sendWithCharge).toHaveBeenCalledTimes(1);
    const failed = h.updates.filter((u) => u.patch.status === "failed");
    expect(failed.map((u) => u.patch.error_message)).toEqual(Array(4).fill("insufficient_tokens"));
  });
});

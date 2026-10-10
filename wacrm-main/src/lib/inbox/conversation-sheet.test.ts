import { describe, expect, it } from "vitest";

import { conversationToRows, parseCsv, rowsToCsv, sheetToMessages } from "./conversation-sheet";
import type { Message } from "@/types";

const msg = (over: Partial<Message>): Message =>
  ({
    id: "m",
    conversation_id: "c",
    sender_type: "customer",
    content_type: "text",
    status: "read",
    created_at: "2026-10-10T09:00:00Z",
    ...over,
  }) as Message;

describe("conversation sheet", () => {
  it("round-trips a conversation through CSV", () => {
    const rows = conversationToRows([
      msg({ id: "2", sender_type: "agent", content_text: 'Yes, "free" delivery, 3–5 days', created_at: "2026-10-10T09:01:00Z" }),
      msg({ id: "1", content_text: "Do you deliver?\nTo Bangalore" }),
      msg({ id: "3", sender_type: "bot", ai_generated: true, content_text: "Anything else?", created_at: "2026-10-10T09:02:00Z" }),
    ]);
    expect(rows.map((r) => r.from)).toEqual(["Customer", "Agent", "AI"]);

    const parsed = sheetToMessages(parseCsv(rowsToCsv(rows)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.messages.map((m) => m.text)).toEqual([
      "Do you deliver?\nTo Bangalore",
      'Yes, "free" delivery, 3–5 days',
      "Anything else?",
    ]);
  });

  it("accepts hand-made sheets and rejects ones without a Message column", () => {
    const ok = sheetToMessages([["from", "message"], ["client", "hi"], ["us", "hello"]]);
    expect(ok.ok && ok.messages.map((m) => m.from)).toEqual(["Customer", "Agent"]);
    expect(sheetToMessages([["a", "b"]])).toEqual({ ok: false, error: "no_header" });
  });
});

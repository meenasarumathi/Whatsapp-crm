import { describe, expect, it } from "vitest";

import { replyTap, replyText, startSimulation, type SimFlow } from "./simulate";

const CONTACT = { name: "Gru", email: "", phone: "+15550001", company: "", tagIds: [] };

const flow: SimFlow = {
  trigger_type: "keyword",
  trigger_config: { keywords: ["price"], match_type: "contains" },
  fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 1, on_exhaust: "handoff" },
  nodes: [
    { node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
    {
      node_key: "ask",
      node_type: "collect_input",
      config: { prompt_text: "Your name?", var_key: "name", next_node_key: "menu" },
    },
    {
      node_key: "menu",
      node_type: "send_buttons",
      config: {
        text: "Hi {{vars.name}}, pick one",
        buttons: [
          { reply_id: "vip", title: "VIP", next_node_key: "tag" },
          { reply_id: "no", title: "No", next_node_key: "bye" },
        ],
      },
    },
    { node_key: "tag", node_type: "set_tag", config: { mode: "add", tag_id: "t1", next_node_key: "check" } },
    {
      node_key: "check",
      node_type: "condition",
      config: { subject: "tag", subject_key: "t1", operator: "present", true_next: "human", false_next: "bye" },
    },
    { node_key: "human", node_type: "handoff", config: { note: "lead {{vars.name}}" } },
    { node_key: "bye", node_type: "end", config: {} },
  ],
};

describe("flow simulator", () => {
  it("checks the trigger and stops at the first input node", () => {
    const s = startSimulation(flow, CONTACT, "what's the price?");
    expect(s.events[1]).toMatchObject({ kind: "notice", code: "trigger_matched" });
    expect(s.status).toBe("waiting");
    expect(s.currentKey).toBe("ask");
  });

  it("captures input, interpolates it, and follows taps through tags and conditions", () => {
    let s = startSimulation(flow, CONTACT);
    s = replyText(flow, s, "Gru");
    expect(s.vars.name).toBe("Gru");
    expect(s.events.at(-1)).toMatchObject({ kind: "bot_buttons", text: "Hi Gru, pick one" });
    s = replyTap(flow, s, "vip", "VIP");
    expect(s.contact.tagIds).toEqual(["t1"]);
    expect(s.status).toBe("handed_off");
    expect(s.events.at(-1)).toMatchObject({ code: "handoff", params: { note: "lead Gru" } });
  });

  it("applies the fallback policy to off-script replies", () => {
    let s = startSimulation(flow, CONTACT);
    s = replyText(flow, s, "Gru");
    s = replyText(flow, s, "huh?");
    expect(s.status).toBe("waiting");
    expect(s.events.some((e) => e.kind === "notice" && e.code === "reprompt")).toBe(true);
    s = replyText(flow, s, "still no");
    expect(s.status).toBe("handed_off");
  });

  it("does not touch the caller's contact", () => {
    let s = startSimulation(flow, CONTACT);
    s = replyText(flow, s, "Gru");
    replyTap(flow, s, "vip", "VIP");
    expect(CONTACT.tagIds).toEqual([]);
  });
});

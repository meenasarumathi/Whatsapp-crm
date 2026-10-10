/**
 * In-editor flow simulator — "Test flow" without WhatsApp.
 *
 * Walks the flow the author is editing (unsaved changes included)
 * entirely in the browser. Nothing is sent to Meta, no flow_run is
 * written, no tag is changed on a real contact — so testing never
 * creates a billable WhatsApp conversation.
 *
 * It follows the same rules as the real runner (`engine.ts`) by
 * sharing its pure helpers (`./pure`) and fallback policy
 * (`./fallback`): button / list taps route by reply_id, collect_input
 * captures typed text into vars, conditions use the same predicate,
 * `{{vars.x}}` interpolation is identical, and an off-script reply
 * applies the flow's reprompt / handoff / end policy.
 *
 * Pure and immutable: every call returns a new state.
 */

import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  evaluateConditionPredicate,
  interpolateOptionalVars,
  interpolateVars,
  matchReplyId,
  matchesKeywordTrigger,
} from "./pure";
import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMediaNodeConfig,
  SendMessageNodeConfig,
  SetTagNodeConfig,
} from "./types";

export interface SimNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface SimContact {
  name: string;
  email: string;
  phone: string;
  company: string;
  /** Tag ids the test contact carries (set_tag nodes change this). */
  tagIds: string[];
}

export type SimNoticeCode =
  | "trigger_matched"
  | "trigger_not_matched"
  | "trigger_manual"
  | "var_saved"
  | "condition"
  | "tag_added"
  | "tag_removed"
  | "reprompt"
  | "handoff"
  | "fallback_handoff"
  | "fallback_end"
  | "ignored"
  | "completed"
  | "node_missing"
  | "loop_guard"
  | "not_waiting";

export type SimEvent =
  | { kind: "bot_text"; node_key: string; text: string }
  | {
      kind: "bot_buttons";
      node_key: string;
      text: string;
      header?: string;
      footer?: string;
      buttons: { reply_id: string; title: string }[];
    }
  | {
      kind: "bot_list";
      node_key: string;
      text: string;
      button_label: string;
      header?: string;
      footer?: string;
      sections: {
        title?: string;
        rows: { reply_id: string; title: string; description?: string }[];
      }[];
    }
  | {
      kind: "bot_media";
      node_key: string;
      media_type: SendMediaNodeConfig["media_type"];
      media_url: string;
      caption?: string;
      filename?: string;
    }
  | { kind: "customer_text"; text: string }
  | { kind: "customer_tap"; reply_id: string; title: string }
  | {
      kind: "notice";
      code: SimNoticeCode;
      node_key?: string;
      /** Values for the notice's message (var name, tag id, result …). */
      params?: Record<string, string>;
    };

export type SimStatus =
  | "waiting"
  | "completed"
  | "handed_off"
  | "failed";

export interface SimState {
  status: SimStatus;
  /** Node waiting for the customer (buttons / list / collect_input). */
  currentKey: string | null;
  vars: Record<string, string>;
  repromptCount: number;
  contact: SimContact;
  events: SimEvent[];
  /** Every node the test has entered, for highlighting on the canvas. */
  visited: string[];
}

export interface SimFlow {
  nodes: SimNode[];
  trigger_type: string;
  trigger_config: unknown;
  fallback_policy: unknown;
}

/** Hard stop for auto-advancing cycles (A → B → A with no input). */
const MAX_STEPS = 100;

function nodeMap(nodes: SimNode[]): Map<string, SimNode> {
  return new Map(nodes.map((n) => [n.node_key, n]));
}

/**
 * Would this first customer message start the flow? Mirrors the
 * runner's entry check for the three trigger types.
 */
export function checkTrigger(
  flow: Pick<SimFlow, "trigger_type" | "trigger_config">,
  firstMessage: string,
): SimEvent {
  if (flow.trigger_type === "manual") {
    return { kind: "notice", code: "trigger_manual" };
  }
  if (flow.trigger_type === "first_inbound_message") {
    return { kind: "notice", code: "trigger_matched", params: { trigger: "first_inbound_message" } };
  }
  const cfg = (flow.trigger_config ?? {}) as KeywordTriggerConfig;
  const hit = matchesKeywordTrigger(firstMessage, cfg);
  return {
    kind: "notice",
    code: hit ? "trigger_matched" : "trigger_not_matched",
    params: {
      trigger: "keyword",
      keywords: (cfg.keywords ?? []).filter(Boolean).join(", "),
    },
  };
}

/**
 * Start a test run. `firstMessage` (optional) is shown as the
 * customer's opening line and checked against the trigger.
 */
export function startSimulation(
  flow: SimFlow,
  contact: SimContact,
  firstMessage?: string,
): SimState {
  const base: SimState = {
    status: "waiting",
    currentKey: null,
    vars: {},
    repromptCount: 0,
    contact: { ...contact, tagIds: [...contact.tagIds] },
    events: [],
    visited: [],
  };
  if (firstMessage && firstMessage.trim()) {
    base.events.push({ kind: "customer_text", text: firstMessage.trim() });
    base.events.push(checkTrigger(flow, firstMessage.trim()));
  }
  const start = flow.nodes.find((n) => n.node_type === "start");
  if (!start) {
    base.events.push({ kind: "notice", code: "node_missing", params: { node: "start" } });
    return { ...base, status: "failed" };
  }
  return advance(base, nodeMap(flow.nodes), start.node_key);
}

/** The customer typed `text`. */
export function replyText(flow: SimFlow, state: SimState, text: string): SimState {
  const trimmed = text.trim();
  if (!trimmed) return state;
  const next: SimState = {
    ...state,
    events: [...state.events, { kind: "customer_text", text: trimmed }],
  };
  return handleReply(flow, next, { kind: "text", text: trimmed });
}

/** The customer tapped a button / list row. */
export function replyTap(
  flow: SimFlow,
  state: SimState,
  reply_id: string,
  title: string,
): SimState {
  const next: SimState = {
    ...state,
    events: [...state.events, { kind: "customer_tap", reply_id, title }],
  };
  return handleReply(flow, next, { kind: "tap", reply_id });
}

function handleReply(
  flow: SimFlow,
  state: SimState,
  reply: { kind: "text"; text: string } | { kind: "tap"; reply_id: string },
): SimState {
  if (state.status !== "waiting" || !state.currentKey) {
    return withNotice(state, "not_waiting");
  }
  const nodes = nodeMap(flow.nodes);
  const current = nodes.get(state.currentKey);
  if (!current) {
    return { ...withNotice(state, "node_missing", state.currentKey, { node: state.currentKey }), status: "failed" };
  }

  let matched: string | null = null;
  let vars = state.vars;
  if (
    reply.kind === "tap" &&
    (current.node_type === "send_buttons" || current.node_type === "send_list")
  ) {
    matched = matchReplyId(current, reply.reply_id);
  } else if (reply.kind === "text" && current.node_type === "collect_input") {
    const cfg = current.config as unknown as CollectInputNodeConfig;
    if (cfg.var_key) {
      vars = { ...vars, [cfg.var_key]: reply.text };
      state = withNotice(
        { ...state, vars },
        "var_saved",
        current.node_key,
        { var: cfg.var_key, value: reply.text },
      );
      matched = cfg.next_node_key;
    }
  }

  if (matched) {
    return advance({ ...state, repromptCount: 0 }, nodes, matched);
  }

  // Off-script reply → the flow's fallback policy, as in the engine.
  const policy = resolveFallbackPolicy(flow.fallback_policy);
  const repromptCount = state.repromptCount + 1;
  const action = decideFallback({ policy, reprompt_count: repromptCount });
  const counted = { ...state, repromptCount };
  switch (action.type) {
    case "ignore":
      return withNotice(counted, "ignored", current.node_key);
    case "reprompt": {
      const prompted = withNotice(counted, "reprompt", current.node_key, {
        count: String(repromptCount),
        max: String(policy.max_reprompts),
      });
      return { ...prompted, events: [...prompted.events, ...promptEvents(current, vars)] };
    }
    case "handoff":
      return {
        ...withNotice(counted, "fallback_handoff", current.node_key),
        status: "handed_off",
        currentKey: null,
      };
    case "end":
      return {
        ...withNotice(counted, "fallback_end", current.node_key),
        status: "completed",
        currentKey: null,
      };
  }
}

/** The bubble(s) a suspending node sends, interpolated against vars. */
function promptEvents(node: SimNode, vars: Record<string, string>): SimEvent[] {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    return [
      {
        kind: "bot_buttons",
        node_key: node.node_key,
        text: interpolateVars(cfg.text, vars),
        header: interpolateOptionalVars(cfg.header_text, vars),
        footer: interpolateOptionalVars(cfg.footer_text, vars),
        buttons: (cfg.buttons ?? []).map((b) => ({
          reply_id: b.reply_id,
          title: interpolateVars(b.title, vars),
        })),
      },
    ];
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    return [
      {
        kind: "bot_list",
        node_key: node.node_key,
        text: interpolateVars(cfg.text, vars),
        button_label: interpolateVars(cfg.button_label, vars),
        header: interpolateOptionalVars(cfg.header_text, vars),
        footer: interpolateOptionalVars(cfg.footer_text, vars),
        sections: (cfg.sections ?? []).map((s) => ({
          title: interpolateOptionalVars(s.title, vars),
          rows: (s.rows ?? []).map((r) => ({
            reply_id: r.reply_id,
            title: interpolateVars(r.title, vars),
            description: interpolateOptionalVars(r.description, vars),
          })),
        })),
      },
    ];
  }
  if (node.node_type === "collect_input") {
    const cfg = node.config as unknown as CollectInputNodeConfig;
    return [{ kind: "bot_text", node_key: node.node_key, text: interpolateVars(cfg.prompt_text, vars) }];
  }
  return [];
}

function withNotice(
  state: SimState,
  code: SimNoticeCode,
  node_key?: string,
  params?: Record<string, string>,
): SimState {
  return { ...state, events: [...state.events, { kind: "notice", code, node_key, params }] };
}

function conditionSubject(cfg: ConditionNodeConfig, state: SimState): string | undefined {
  if (cfg.subject === "var") return state.vars[cfg.subject_key];
  if (cfg.subject === "tag") {
    return state.contact.tagIds.includes(cfg.subject_key) ? cfg.subject_key : undefined;
  }
  const field = cfg.subject_key as keyof Omit<SimContact, "tagIds">;
  const raw = state.contact[field];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Run auto-advancing nodes from `key` until input is needed or the run ends. */
function advance(state: SimState, nodes: Map<string, SimNode>, key: string): SimState {
  let s: SimState = { ...state, events: [...state.events], visited: [...state.visited] };
  let nextKey: string | null = key;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (!nextKey) {
      return { ...withNotice(s, "completed"), status: "completed", currentKey: null };
    }
    const node = nodes.get(nextKey);
    if (!node) {
      return {
        ...withNotice(s, "node_missing", nextKey, { node: nextKey }),
        status: "failed",
        currentKey: null,
      };
    }
    s.visited.push(node.node_key);

    switch (node.node_type) {
      case "start":
        nextKey = (node.config.next_node_key as string) || null;
        break;
      case "send_message": {
        const cfg = node.config as unknown as SendMessageNodeConfig;
        s.events.push({ kind: "bot_text", node_key: node.node_key, text: interpolateVars(cfg.text, s.vars) });
        nextKey = cfg.next_node_key || null;
        break;
      }
      case "send_media": {
        const cfg = node.config as unknown as SendMediaNodeConfig;
        s.events.push({
          kind: "bot_media",
          node_key: node.node_key,
          media_type: cfg.media_type,
          media_url: cfg.media_url,
          caption: interpolateOptionalVars(cfg.caption, s.vars),
          filename: cfg.filename,
        });
        nextKey = cfg.next_node_key || null;
        break;
      }
      case "send_buttons":
      case "send_list":
      case "collect_input":
        s.events.push(...promptEvents(node, s.vars));
        return { ...s, status: "waiting", currentKey: node.node_key };
      case "condition": {
        const cfg = node.config as unknown as ConditionNodeConfig;
        const result = evaluateConditionPredicate({
          operator: cfg.operator,
          subjectValue: conditionSubject(cfg, s),
          configValue: cfg.value,
        });
        s = withNotice(s, "condition", node.node_key, {
          result: String(result),
          subject: cfg.subject,
          key: cfg.subject_key ?? "",
          operator: cfg.operator,
          value: cfg.value ?? "",
        });
        nextKey = (result ? cfg.true_next : cfg.false_next) || null;
        break;
      }
      case "set_tag": {
        const cfg = node.config as unknown as SetTagNodeConfig;
        const has = s.contact.tagIds.includes(cfg.tag_id);
        const tagIds =
          cfg.mode === "remove"
            ? s.contact.tagIds.filter((id) => id !== cfg.tag_id)
            : has
              ? s.contact.tagIds
              : [...s.contact.tagIds, cfg.tag_id];
        s = withNotice(
          { ...s, contact: { ...s.contact, tagIds } },
          cfg.mode === "remove" ? "tag_removed" : "tag_added",
          node.node_key,
          { tag: cfg.tag_id },
        );
        nextKey = cfg.next_node_key || null;
        break;
      }
      case "handoff": {
        const note = interpolateOptionalVars(node.config.note as string | undefined, s.vars);
        return {
          ...withNotice(s, "handoff", node.node_key, note ? { note } : undefined),
          status: "handed_off",
          currentKey: null,
        };
      }
      case "end":
        return { ...withNotice(s, "completed", node.node_key), status: "completed", currentKey: null };
      default:
        return {
          ...withNotice(s, "node_missing", node.node_key, { node: node.node_type }),
          status: "failed",
          currentKey: null,
        };
    }
  }
  return { ...withNotice(s, "loop_guard"), status: "failed", currentKey: null };
}

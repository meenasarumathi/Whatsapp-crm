/**
 * Pure flow-runner helpers — no the database, no Meta, safe to import from
 * client components. The engine (`engine.ts`) re-exports these; the
 * in-editor "Test flow" simulator (`simulate.ts`) walks a flow with the
 * very same matching, condition and interpolation rules, so a test run
 * behaves like a real one without sending anything to WhatsApp.
 */

import type {
  ConditionNodeConfig,
  KeywordTriggerConfig,
  ParsedInbound,
  SendButtonsNodeConfig,
  SendListNodeConfig,
} from "./types";

// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
export function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
export function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}

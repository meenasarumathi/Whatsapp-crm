// ============================================================
// AI training — pure helpers (client- and server-safe).
//
// "Train AI" stores three things (migration 044):
//   - a guided business profile (one per account),
//   - rules ("always …" / "never …"),
//   - Q&A pairs: a customer question and the ideal answer.
//
// At reply time the profile, every active rule and the Q&A pairs most
// similar to the customer's latest message are rendered into one
// "Training" block of the system prompt (see `buildSystemPrompt`).
// Q&A pairs are picked by word overlap — cheap, needs no embeddings
// key, and good enough for the dozens-to-hundreds of pairs a business
// typically writes.
// ============================================================

export type ReplyLength = "short" | "medium" | "detailed";

export interface TrainingProfile {
  businessName?: string;
  whatYouSell?: string;
  audience?: string;
  tone?: string;
  languages?: string;
  hours?: string;
  location?: string;
  pricing?: string;
  policies?: string;
  goals?: string;
  escalation?: string;
  replyLength?: ReplyLength;
  useEmojis?: boolean;
}

/** Profile questions, in the order the Train AI wizard asks them. */
export const PROFILE_FIELDS: {
  key: Exclude<keyof TrainingProfile, "replyLength" | "useEmojis">;
  multiline: boolean;
}[] = [
  { key: "businessName", multiline: false },
  { key: "whatYouSell", multiline: true },
  { key: "audience", multiline: true },
  { key: "tone", multiline: false },
  { key: "languages", multiline: false },
  { key: "hours", multiline: false },
  { key: "location", multiline: false },
  { key: "pricing", multiline: true },
  { key: "policies", multiline: true },
  { key: "goals", multiline: true },
  { key: "escalation", multiline: true },
];

const PROFILE_LABELS: Record<(typeof PROFILE_FIELDS)[number]["key"], string> = {
  businessName: "Business name",
  whatYouSell: "What we sell / do",
  audience: "Our customers",
  tone: "Tone of voice",
  languages: "Languages",
  hours: "Opening hours",
  location: "Location / service area",
  pricing: "Pricing",
  policies: "Policies (delivery, refunds, payment)",
  goals: "What every chat should achieve",
  escalation: "Hand over to a human when",
};

export interface TrainingExample {
  id: string;
  kind: "qa" | "rule";
  question: string | null;
  answer: string;
  category?: string | null;
  is_active?: boolean;
}

export const MAX_QA_IN_PROMPT = 8;
export const MAX_RULES_IN_PROMPT = 30;
const MAX_FIELD_CHARS = 1500;

function clip(s: string, max = MAX_FIELD_CHARS): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Fraction of the profile filled in (0–1), for the readiness meter. */
export function profileCompleteness(profile: TrainingProfile): number {
  const filled = PROFILE_FIELDS.filter((f) => (profile[f.key] ?? "").trim()).length;
  return filled / PROFILE_FIELDS.length;
}

/**
 * 0–100 "AI readiness" score shown on the Train AI page: profile 40,
 * Q&A pairs 30 (full at 15), rules 10 (full at 3), knowledge docs 20
 * (full at 2).
 */
export function readinessScore(args: {
  profile: TrainingProfile;
  qaCount: number;
  ruleCount: number;
  knowledgeDocs: number;
}): number {
  const score =
    profileCompleteness(args.profile) * 40 +
    Math.min(args.qaCount / 15, 1) * 30 +
    Math.min(args.ruleCount / 3, 1) * 10 +
    Math.min(args.knowledgeDocs / 2, 1) * 20;
  return Math.round(score);
}

const STOPWORDS = new Set(
  "a an the is are was were be to of in on for and or but with at by from it this that what which how do does did can could would should i you we they me my your our us please hi hello hey".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * The `k` Q&A pairs whose question best overlaps `query`. Pairs with no
 * overlap are skipped unless there are few enough to include them all.
 */
export function selectRelevantExamples(
  examples: TrainingExample[],
  query: string,
  k = MAX_QA_IN_PROMPT,
): TrainingExample[] {
  const qa = examples.filter((e) => e.kind === "qa" && e.is_active !== false && e.question);
  if (qa.length <= k) return qa;
  const q = new Set(tokens(query));
  return qa
    .map((e) => {
      const words = tokens(`${e.question} ${e.category ?? ""}`);
      const hits = words.filter((w) => q.has(w)).length;
      return { e, score: words.length ? hits / Math.sqrt(words.length) : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.e);
}

/**
 * Render the training block for the system prompt, or null when nothing
 * has been trained yet.
 */
export function buildTrainingBlock(args: {
  profile: TrainingProfile | null;
  rules: TrainingExample[];
  examples: TrainingExample[];
}): string | null {
  const parts: string[] = [];
  const p = args.profile ?? {};

  const profileLines = PROFILE_FIELDS.flatMap((f) => {
    const v = (p[f.key] ?? "").trim();
    return v ? [`- ${PROFILE_LABELS[f.key]}: ${clip(v)}`] : [];
  });
  if (p.replyLength) {
    profileLines.push(
      `- Reply length: ${
        p.replyLength === "short"
          ? "short — one or two sentences"
          : p.replyLength === "detailed"
            ? "detailed when the question needs it"
            : "medium — a short paragraph"
      }`,
    );
  }
  if (p.useEmojis !== undefined) {
    profileLines.push(`- Emojis: ${p.useEmojis ? "a few are welcome" : "do not use emojis"}`);
  }
  if (profileLines.length) parts.push(`Business profile:\n${profileLines.join("\n")}`);

  const rules = args.rules
    .filter((r) => r.kind === "rule" && r.is_active !== false && r.answer.trim())
    .slice(0, MAX_RULES_IN_PROMPT);
  if (rules.length) {
    parts.push(`Rules you must follow:\n${rules.map((r) => `- ${clip(r.answer, 500)}`).join("\n")}`);
  }

  if (args.examples.length) {
    parts.push(
      "Approved example answers written by the business. When the customer asks something similar, answer the same way (adapt wording, keep the facts):\n" +
        args.examples
          .map((e) => `Q: ${clip(e.question ?? "", 500)}\nA: ${clip(e.answer, 1000)}`)
          .join("\n\n"),
    );
  }

  return parts.length ? `Training from the business:\n\n${parts.join("\n\n")}` : null;
}

export interface Turn {
  fromCustomer: boolean;
  text: string;
}

/**
 * Pair up a conversation into Q&A suggestions: each run of customer
 * messages is a question, the business messages that follow are its
 * answer. Leading business messages (greetings, broadcasts) and an
 * unanswered final question are dropped.
 */
export function pairsFromTurns(turns: Turn[]): { question: string; answer: string }[] {
  const pairs: { question: string; answer: string }[] = [];
  let q: string[] = [];
  let a: string[] = [];
  const flush = () => {
    if (q.length && a.length) {
      pairs.push({ question: clip(q.join("\n"), 1000), answer: clip(a.join("\n"), 2000) });
    }
    q = [];
    a = [];
  };
  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text || /^\[[a-z_ :.-]+\]$/i.test(text)) continue; // media placeholders
    if (turn.fromCustomer) {
      if (a.length) flush();
      q.push(text);
    } else if (q.length) {
      a.push(text);
    }
  }
  flush();
  return pairs;
}

import { describe, expect, it } from "vitest";

import { buildTrainingBlock, pairsFromTurns, readinessScore, selectRelevantExamples } from "./training";

describe("Train AI helpers", () => {
  it("pairs customer questions with the replies that follow", () => {
    expect(
      pairsFromTurns([
        { fromCustomer: false, text: "Welcome!" },
        { fromCustomer: true, text: "Price?" },
        { fromCustomer: true, text: "For gold" },
        { fromCustomer: false, text: "From 8%" },
        { fromCustomer: true, text: "[image]" },
        { fromCustomer: true, text: "Unanswered" },
      ]),
    ).toEqual([{ question: "Price?\nFor gold", answer: "From 8%" }]);
  });

  it("picks the most relevant Q&A pairs", () => {
    const qa = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      kind: "qa" as const,
      question: i === 7 ? "Do you deliver to Bangalore?" : `Unrelated topic ${i}`,
      answer: "a",
    }));
    expect(selectRelevantExamples(qa, "delivery to bangalore please", 3)[0].id).toBe("7");
  });

  it("renders profile, rules and examples, or nothing", () => {
    expect(buildTrainingBlock({ profile: null, rules: [], examples: [] })).toBeNull();
    const block = buildTrainingBlock({
      profile: { businessName: "Acme", useEmojis: false },
      rules: [{ id: "r", kind: "rule", question: null, answer: "Never quote dates" }],
      examples: [{ id: "q", kind: "qa", question: "Open Sunday?", answer: "No" }],
    })!;
    expect(block).toContain("Business name: Acme");
    expect(block).toContain("- Never quote dates");
    expect(block).toContain("Q: Open Sunday?\nA: No");
  });

  it("scores readiness out of 100", () => {
    expect(readinessScore({ profile: {}, qaCount: 0, ruleCount: 0, knowledgeDocs: 0 })).toBe(0);
    expect(readinessScore({ profile: {}, qaCount: 15, ruleCount: 3, knowledgeDocs: 2 })).toBe(60);
  });
});

import { describe, expect, it } from "vitest";
import { formatAge, PIPELINE_TEMPLATES, stageAge, templateStageRows } from "./templates";

const now = new Date("2026-11-04T12:00:00Z");

describe("stageAge", () => {
  it("is overdue past the stage SLA", () => {
    const deal = { stage_entered_at: "2026-11-04T09:00:00Z", created_at: "", status: "open" as const };
    expect(stageAge(deal, { sla_hours: 2, outcome: "open" }, now)).toEqual({ hours: 3, overdue: true });
    expect(stageAge(deal, { sla_hours: 4, outcome: "open" }, now).overdue).toBe(false);
  });
  it("never flags closed deals or stages without an SLA", () => {
    const deal = { stage_entered_at: "2026-11-01T00:00:00Z", created_at: "", status: "won" as const };
    expect(stageAge(deal, { sla_hours: 2, outcome: "open" }, now).overdue).toBe(false);
    expect(stageAge({ ...deal, status: "open" }, { sla_hours: null, outcome: "open" }, now).overdue).toBe(false);
    expect(stageAge({ ...deal, status: "open" }, { sla_hours: 1, outcome: "won" }, now).overdue).toBe(false);
  });
  it("falls back to created_at", () => {
    expect(stageAge({ created_at: "2026-11-04T11:00:00Z" }, null, now).hours).toBe(1);
  });
});

describe("templates", () => {
  it("settlement flow ends in one won and one lost stage", () => {
    const outcomes = PIPELINE_TEMPLATES.settlement.map((s) => s.outcome);
    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    expect(outcomes.at(-1)).toBe("lost");
  });
  it("rows carry positions", () => {
    expect(templateStageRows("p", "sales").map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
  });
  it("formats ages", () => {
    expect([formatAge(0.2), formatAge(5.4), formatAge(72)]).toEqual(["12m", "5h", "3d"]);
  });
});

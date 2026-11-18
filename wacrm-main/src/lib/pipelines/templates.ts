// ============================================================
// Pipeline templates offered when a pipeline is created, plus the
// stage-age / SLA helper the board uses. Stage owners are chosen per
// account afterwards (Manage pipeline), so templates carry none.
// ============================================================

import type { Deal, PipelineStage } from "@/types";

export interface StageTemplate {
  name: string;
  color: string;
  sla_hours: number | null;
  outcome: "open" | "won" | "lost";
}

export type PipelineTemplateKey = "settlement" | "sales";

export const PIPELINE_TEMPLATES: Record<PipelineTemplateKey, StageTemplate[]> = {
  // Entry to settlement: every hand-off point a small sales + fulfilment
  // team has, each with an SLA so stuck deals surface.
  settlement: [
    { name: "New enquiry", color: "#3b82f6", sla_hours: 2, outcome: "open" },
    { name: "Qualified", color: "#6366f1", sla_hours: 24, outcome: "open" },
    { name: "Quote sent", color: "#eab308", sla_hours: 48, outcome: "open" },
    { name: "Order confirmed", color: "#f97316", sla_hours: 24, outcome: "open" },
    { name: "Payment received", color: "#14b8a6", sla_hours: 24, outcome: "open" },
    { name: "Dispatched", color: "#06b6d4", sla_hours: 72, outcome: "open" },
    { name: "Settled", color: "#22c55e", sla_hours: null, outcome: "won" },
    { name: "Lost", color: "#f43f5e", sla_hours: null, outcome: "lost" },
  ],
  sales: [
    { name: "New Lead", color: "#3b82f6", sla_hours: null, outcome: "open" },
    { name: "Qualified", color: "#eab308", sla_hours: null, outcome: "open" },
    { name: "Proposal Sent", color: "#f97316", sla_hours: null, outcome: "open" },
    { name: "Negotiation", color: "#8b5cf6", sla_hours: null, outcome: "open" },
    { name: "Won", color: "#22c55e", sla_hours: null, outcome: "won" },
  ],
};

export function templateStageRows(pipelineId: string, key: PipelineTemplateKey) {
  return PIPELINE_TEMPLATES[key].map((s, position) => ({ pipeline_id: pipelineId, position, ...s }));
}

/** How long the deal has been in its stage, and whether it broke the stage SLA. Closed deals are never overdue. */
export function stageAge(
  deal: Pick<Deal, "stage_entered_at" | "created_at" | "status">,
  stage: Pick<PipelineStage, "sla_hours" | "outcome"> | null | undefined,
  now: Date = new Date(),
): { hours: number; overdue: boolean } {
  const since = new Date(deal.stage_entered_at ?? deal.created_at).getTime();
  const hours = Math.max(0, (now.getTime() - since) / 3_600_000);
  const open = (deal.status ?? "open") === "open" && (stage?.outcome ?? "open") === "open";
  return { hours, overdue: open && stage?.sla_hours != null && hours > stage.sla_hours };
}

/** Compact age label: 45m, 5h, 3d. */
export function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

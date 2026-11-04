import { WORKFLOWS, type WorkflowKey, type WorkflowResources } from './workflow-library'

// Automation names each workflow installs, computed with placeholder
// resources (names never depend on the account). Used to tell which
// workflows an account already has.
const PLACEHOLDER: WorkflowResources = {
  businessName: 'x',
  pipelineId: 'x',
  stages: new Proxy({}, { get: () => 'x' }) as Record<string, string>,
  tags: new Proxy({}, { get: () => 'x' }) as Record<string, string>,
}

export const WORKFLOW_DRAFT_NAMES = Object.fromEntries(
  WORKFLOWS.map((w) => [w.key, w.build(PLACEHOLDER).map((d) => d.name)]),
) as Record<WorkflowKey, string[]>

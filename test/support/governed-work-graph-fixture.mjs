import {
  buildGraphProjection,
  createGraphEdge,
  createGraphNode,
} from "../../src/governed-work-graph.mjs";

export function graphFixture({ invalidatePermission = false } = {}) {
  const tenantId = "tenant-query";
  const projectId = "project-query";
  const observedAt = "2026-08-12T08:00:00.000Z";
  const authorizationHash = "a".repeat(64);
  const planId = "plan_123456789012345678901234";
  const stepDomainId = `${planId}:research`;
  const memoryId = "memory-1";
  const node = (nodeType, domainId, revision, extra = {}) => createGraphNode({
    tenantId, projectId, nodeType, domainId, revision, observedAt,
    provenance: { recordType: nodeType, recordId: domainId, recordVersion: revision },
    ...extra,
  });
  const project = node("project", projectId, authorizationHash);
  const authorization = node("authorization", authorizationHash, authorizationHash, { sensitivity: "confidential" });
  const plan = node("plan", planId, "p".repeat(64));
  const step = node("step", stepDomainId, "step-v1");
  const capability = node("capability", `${projectId}:research`, "cap-v1", { sensitivity: "confidential" });
  const evidence = node("evidence", stepDomainId, "evidence-v1");
  const outcome = node("outcome", planId, "outcome-v1");
  const timeReturn = node("time_return", "time-1", "time-v1");
  const source = node("source", "source-hash", "source-v1", {
    sensitivity: "confidential", expiresAt: "2026-12-31T00:00:00.000Z",
  });
  const memory = node("memory", memoryId, "memory-v1", {
    sensitivity: "confidential", expiresAt: "2026-12-31T00:00:00.000Z",
  });
  const edge = (edgeType, from, to, phase, extra = {}) => createGraphEdge({
    edgeType, from, to, phase, observedAt, authorizationHash,
    provenance: { recordType: "fixture", recordId: edgeType, recordVersion: "v1" },
    ...extra,
  });
  const edges = [
    edge("project.has_authorization", project, authorization, "intended"),
    edge("plan.contains_step", plan, step, "intended"),
    edge("authorization.permits_step", authorization, step, "intended", invalidatePermission
      ? { invalidatedAt: observedAt } : {}),
    edge("step.uses_capability", step, capability, "intended"),
    edge("authorization.grants_capability", authorization, capability, "intended"),
    edge("plan.contains_step", plan, step, "runtime"),
    edge("step.uses_capability", step, capability, "runtime"),
    edge("step.produces_evidence", step, evidence, "runtime"),
    edge("plan.produces_outcome", plan, outcome, "runtime"),
    edge("plan.proposes_time_return", plan, timeReturn, "runtime"),
    edge("plan.proposes_memory", plan, memory, "runtime"),
    edge("source.supports_memory", source, memory, "runtime", { authorizationHash: null }),
    edge("memory.informs_plan", memory, plan, "runtime"),
  ];
  return {
    scope: { tenantId, projectId },
    observedAt,
    authorizationHash,
    planId,
    stepDomainId,
    memoryId,
    graph: buildGraphProjection({
      nodes: [project, authorization, plan, step, capability, evidence, outcome, timeReturn, source, memory],
      edges,
    }),
  };
}

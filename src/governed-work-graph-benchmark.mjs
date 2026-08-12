import { performance } from "node:perf_hooks";
import {
  buildGraphProjection,
  createGraphEdge,
  createGraphNode,
} from "./governed-work-graph.mjs";
import {
  explainExecutionDrift,
  explainMemorySource,
  explainProjectChanges,
  explainStepAuthorization,
} from "./governed-work-graph-query.mjs";

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function buildGraphBenchmarkFixture({
  tenantId = "benchmark-tenant",
  projectId = "benchmark-project",
  planCount = 30,
  observedAt = "2026-08-12T08:00:00.000Z",
} = {}) {
  if (!Number.isSafeInteger(planCount) || planCount < 1 || planCount > 40) {
    throw new Error("Graph benchmark planCount must be between 1 and 40");
  }
  const authorizationHash = "a".repeat(64);
  const nodes = [];
  const edges = [];
  const node = (nodeType, domainId, revision, extra = {}) => {
    const value = createGraphNode({
      tenantId, projectId, nodeType, domainId, revision, observedAt,
      provenance: { recordType: nodeType, recordId: domainId, recordVersion: revision },
      ...extra,
    });
    nodes.push(value);
    return value;
  };
  const edge = (edgeType, from, to, phase, index, extra = {}) => {
    edges.push(createGraphEdge({
      edgeType, from, to, phase, observedAt, authorizationHash,
      provenance: { recordType: "benchmark", recordId: `${edgeType}:${index}`, recordVersion: "v1" },
      ...extra,
    }));
  };
  const project = node("project", projectId, authorizationHash);
  const authorization = node("authorization", authorizationHash, authorizationHash, {
    sensitivity: "confidential",
  });
  edge("project.has_authorization", project, authorization, "intended", "shared");
  let target = null;
  for (let index = 0; index < planCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const planId = `plan_benchmark_${suffix}`;
    const stepDomainId = `${planId}:research`;
    const memoryId = `memory-benchmark-${suffix}`;
    const plan = node("plan", planId, `${suffix}${"p".repeat(61)}`.slice(0, 64));
    const step = node("step", stepDomainId, `step-${suffix}`);
    const capability = node("capability", `${projectId}:research:${suffix}`, `cap-${suffix}`, {
      sensitivity: "confidential",
    });
    const evidence = node("evidence", stepDomainId, `evidence-${suffix}`);
    const outcome = node("outcome", planId, `outcome-${suffix}`);
    const source = node("source", `source-${suffix}`, `source-v${suffix}`, {
      sensitivity: "confidential",
    });
    const memory = node("memory", memoryId, `memory-v${suffix}`, {
      sensitivity: "confidential",
    });
    const timeReturn = node("time_return", `time-${suffix}`, `time-v${suffix}`);
    edge("plan.contains_step", plan, step, "intended", suffix);
    edge("authorization.permits_step", authorization, step, "intended", suffix);
    edge("step.uses_capability", step, capability, "intended", suffix);
    edge("authorization.grants_capability", authorization, capability, "intended", suffix);
    edge("plan.contains_step", plan, step, "runtime", suffix);
    edge("step.uses_capability", step, capability, "runtime", suffix);
    edge("step.produces_evidence", step, evidence, "runtime", suffix);
    edge("plan.produces_outcome", plan, outcome, "runtime", suffix);
    edge("source.supports_memory", source, memory, "runtime", suffix, { authorizationHash: null });
    edge("memory.informs_plan", memory, plan, "runtime", suffix);
    edge("plan.proposes_time_return", plan, timeReturn, "runtime", suffix);
    target = { planId, stepDomainId, memoryId };
  }
  return {
    tenantId,
    projectId,
    observedAt,
    target,
    graph: buildGraphProjection({ nodes, edges }),
  };
}

export async function benchmarkGovernedGraph({
  store,
  fixture = buildGraphBenchmarkFixture(),
  iterations = 100,
} = {}) {
  if (!store?.appendGraphProjection || !store?.listGraphNodes || !store?.listGraphEdges) {
    throw new Error("Graph benchmark requires a graph-capable store");
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000) {
    throw new Error("Graph benchmark iterations must be between 1 and 1000");
  }
  await store.appendGraphProjection(fixture.graph, new Date(fixture.observedAt));
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const [nodes, edges] = await Promise.all([
      store.listGraphNodes({
        tenantId: fixture.tenantId, projectId: fixture.projectId, limit: 500,
      }),
      store.listGraphEdges({
        tenantId: fixture.tenantId, projectId: fixture.projectId, limit: 500,
      }),
    ]);
    const common = {
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      nodes,
      edges,
      now: fixture.observedAt,
      maxDepth: 4,
      maxResults: 500,
    };
    explainStepAuthorization({ ...common, stepId: fixture.target.stepDomainId });
    explainMemorySource({ ...common, memoryId: fixture.target.memoryId });
    explainExecutionDrift({ ...common, planId: fixture.target.planId });
    explainProjectChanges({ ...common, planId: fixture.target.planId });
    samples.push(performance.now() - started);
  }
  const p50Ms = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  return {
    graphVersion: fixture.graph.graphVersion,
    plans: Number(fixture.target.planId.split("_").at(-1)) + 1,
    nodes: fixture.graph.nodes.length,
    edges: fixture.graph.edges.length,
    iterations,
    p50Ms: Number(p50Ms.toFixed(3)),
    p95Ms: Number(p95Ms.toFixed(3)),
    maximumMs: Number(Math.max(...samples).toFixed(3)),
    decision: p95Ms <= 100
      ? "keep_transactional_store"
      : "review_specialized_graph_store",
  };
}

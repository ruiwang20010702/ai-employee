import { validateGraphEdge, validateGraphNode } from "./governed-work-graph.mjs";

const defaultLimits = Object.freeze({ maxDepth: 4, maxResults: 100 });

function requiredText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function activeAt(edge, now) {
  return edge.state === "active" &&
    !edge.invalidatedAt &&
    edge.validFrom <= now &&
    (!edge.expiresAt || edge.expiresAt > now);
}

function graphView({ tenantId, projectId, nodes = [], edges = [], now = new Date(), ...limits }) {
  const tenant = requiredText(tenantId, "tenantId");
  const project = requiredText(projectId, "projectId");
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error("now must be a timestamp");
  const maxDepth = integer(limits.maxDepth ?? defaultLimits.maxDepth, "maxDepth", 1, 8);
  const maxResults = integer(limits.maxResults ?? defaultLimits.maxResults, "maxResults", 1, 500);
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error("Graph query nodes and edges must be arrays");
  }
  if (nodes.length > maxResults || edges.length > maxResults) {
    throw new Error("Graph query input exceeds maxResults");
  }
  const nodeMap = new Map();
  for (const input of nodes) {
    const node = validateGraphNode(input);
    if (node.tenantId !== tenant || node.projectId !== project) {
      throw new Error("Graph query input crosses tenant or project scope");
    }
    nodeMap.set(node.nodeId, node);
  }
  const normalizedEdges = edges.map((input) => {
    const edge = validateGraphEdge(input);
    if (edge.from.tenantId !== tenant || edge.from.projectId !== project) {
      throw new Error("Graph query input crosses tenant or project scope");
    }
    if (!nodeMap.has(edge.from.nodeId) || !nodeMap.has(edge.to.nodeId)) {
      throw new Error("Graph query contains a dangling edge");
    }
    return edge;
  });
  const isoNow = at.toISOString();
  const latestByRelation = new Map();
  for (const edge of normalizedEdges) {
    const current = latestByRelation.get(edge.relationKey);
    if (!current || edge.observedAt > current.observedAt ||
      (edge.observedAt === current.observedAt && edge.edgeId > current.edgeId)) {
      latestByRelation.set(edge.relationKey, edge);
    }
  }
  return {
    tenantId: tenant,
    projectId: project,
    maxDepth,
    maxResults,
    now: isoNow,
    nodes: [...nodeMap.values()],
    nodeMap,
    edges: normalizedEdges,
    activeEdges: [...latestByRelation.values()].filter((edge) => activeAt(edge, isoNow)),
  };
}

function byNode(view, nodeType, identity) {
  const value = requiredText(identity, `${nodeType} identity`);
  return view.nodes.filter((node) =>
    node.nodeType === nodeType && (node.nodeId === value || node.domainId === value)
  );
}

function edgeSummary(edge) {
  return {
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    phase: edge.phase,
    fromNodeId: edge.from.nodeId,
    toNodeId: edge.to.nodeId,
    authorizationHash: edge.authorizationHash,
    provenance: edge.provenance,
    sensitivity: edge.sensitivity,
    expiresAt: edge.expiresAt,
    observedAt: edge.observedAt,
  };
}

function nodeSummary(node) {
  return {
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    domainId: node.domainId,
    revision: node.revision,
    provenance: node.provenance,
    sensitivity: node.sensitivity,
    expiresAt: node.expiresAt,
    observedAt: node.observedAt,
  };
}

function result(view, query, { status, reason, nodes = [], edges = [], details = {} }) {
  const selectedNodes = nodes.slice(0, view.maxResults);
  const selectedEdges = edges.slice(0, view.maxResults);
  return {
    query,
    scope: {
      tenantId: view.tenantId,
      projectId: view.projectId,
      maxDepth: view.maxDepth,
      maxResults: view.maxResults,
      at: view.now,
    },
    status,
    reason,
    authoritative: false,
    notice: "explanation_only_domain_policy_remains_authoritative",
    nodes: selectedNodes.map(nodeSummary),
    edges: selectedEdges.map(edgeSummary),
    truncated: nodes.length > selectedNodes.length || edges.length > selectedEdges.length,
    ...details,
  };
}

export function explainStepAuthorization(input) {
  const view = graphView(input);
  const steps = byNode(view, "step", input.stepId);
  if (steps.length !== 1) {
    return result(view, "why_may_step_run", {
      status: "denied", reason: steps.length ? "step_revision_is_ambiguous" : "step_not_found",
    });
  }
  const step = steps[0];
  const intended = view.activeEdges.filter((edge) => edge.phase === "intended");
  const containment = intended.filter((edge) =>
    edge.edgeType === "plan.contains_step" && edge.to.nodeId === step.nodeId
  );
  const permission = intended.filter((edge) =>
    edge.edgeType === "authorization.permits_step" && edge.to.nodeId === step.nodeId
  );
  const capabilityUse = intended.filter((edge) =>
    edge.edgeType === "step.uses_capability" && edge.from.nodeId === step.nodeId
  );
  const planIds = new Set(containment.map((edge) => edge.from.nodeId));
  const authorizationIds = new Set(permission.map((edge) => edge.from.nodeId));
  const capabilities = new Set(capabilityUse.map((edge) => edge.to.nodeId));
  const grants = intended.filter((edge) =>
    edge.edgeType === "authorization.grants_capability" &&
    authorizationIds.has(edge.from.nodeId) && capabilities.has(edge.to.nodeId)
  );
  const projectBindings = intended.filter((edge) =>
    edge.edgeType === "project.has_authorization" && authorizationIds.has(edge.to.nodeId)
  );
  const hashes = new Set([...permission, ...containment, ...capabilityUse, ...grants, ...projectBindings]
    .map((edge) => edge.authorizationHash).filter(Boolean));
  const complete = containment.length === 1 && permission.length === 1 &&
    capabilityUse.length === 1 && grants.length === 1 && projectBindings.length === 1 &&
    planIds.size === 1 && hashes.size === 1;
  const selectedEdges = [...containment, ...permission, ...capabilityUse, ...grants, ...projectBindings];
  const selectedNodes = [step, ...new Set(selectedEdges.flatMap((edge) => [edge.from.nodeId, edge.to.nodeId]))]
    .map((value) => typeof value === "string" ? view.nodeMap.get(value) : value)
    .filter(Boolean);
  return result(view, "why_may_step_run", {
    status: complete ? "evidence_complete" : "denied",
    reason: complete ? "intended_authorization_path_is_complete" : "intended_authorization_path_is_incomplete",
    nodes: [...new Map(selectedNodes.map((node) => [node.nodeId, node])).values()],
    edges: selectedEdges,
    details: {
      step: nodeSummary(step),
      planNodeId: complete ? [...planIds][0] : null,
      authorizationHash: complete ? [...hashes][0] : null,
      approvalRequired: "consult_domain_plan_policy",
      remainingBudget: "consult_capability_budget_ledger",
    },
  });
}

export function explainMemorySource(input) {
  const view = graphView(input);
  const memories = byNode(view, "memory", input.memoryId);
  if (memories.length !== 1) {
    return result(view, "which_source_supports_fact", {
      status: "denied", reason: memories.length ? "memory_revision_is_ambiguous" : "memory_not_found",
    });
  }
  const memory = memories[0];
  if (memory.expiresAt && memory.expiresAt <= view.now) {
    return result(view, "which_source_supports_fact", {
      status: "denied", reason: "memory_expired", nodes: [memory],
    });
  }
  const supports = view.activeEdges.filter((edge) =>
    edge.edgeType === "source.supports_memory" && edge.to.nodeId === memory.nodeId
  );
  if (supports.length !== 1) {
    return result(view, "which_source_supports_fact", {
      status: "denied", reason: supports.length ? "source_is_ambiguous" : "source_not_found",
      nodes: [memory], edges: supports,
    });
  }
  const source = view.nodeMap.get(supports[0].from.nodeId);
  return result(view, "which_source_supports_fact", {
    status: "evidence_complete", reason: "exact_source_revision_is_available",
    nodes: [memory, source], edges: supports,
    details: { memory: nodeSummary(memory), source: nodeSummary(source) },
  });
}

export function explainExecutionDrift(input) {
  const view = graphView(input);
  const plans = byNode(view, "plan", input.planId);
  if (plans.length !== 1) {
    return result(view, "did_execution_drift", {
      status: "denied", reason: plans.length ? "plan_revision_is_ambiguous" : "plan_not_found",
    });
  }
  const plan = plans[0];
  const contains = view.activeEdges.filter((edge) =>
    edge.edgeType === "plan.contains_step" && edge.from.nodeId === plan.nodeId
  );
  const intended = new Set(contains.filter((edge) => edge.phase === "intended").map((edge) => edge.to.nodeId));
  const runtime = new Set(contains.filter((edge) => edge.phase === "runtime").map((edge) => edge.to.nodeId));
  const missingAtRuntime = [...intended].filter((id) => !runtime.has(id));
  const unexpectedAtRuntime = [...runtime].filter((id) => !intended.has(id));
  const evidenceEdges = view.activeEdges.filter((edge) =>
    edge.edgeType === "step.produces_evidence" && runtime.has(edge.from.nodeId)
  );
  const evidencedSteps = new Set(evidenceEdges.map((edge) => edge.from.nodeId));
  const missingEvidence = [...runtime].filter((id) => !evidencedSteps.has(id));
  const outcomes = view.activeEdges.filter((edge) =>
    edge.edgeType === "plan.produces_outcome" && edge.from.nodeId === plan.nodeId
  );
  const drift = missingAtRuntime.length > 0 || unexpectedAtRuntime.length > 0;
  const complete = !drift && runtime.size === intended.size && missingEvidence.length === 0 && outcomes.length === 1;
  const selectedEdges = [...contains, ...evidenceEdges, ...outcomes];
  const selectedNodes = [plan, ...selectedEdges.flatMap((edge) => [
    view.nodeMap.get(edge.from.nodeId), view.nodeMap.get(edge.to.nodeId),
  ])].filter(Boolean);
  return result(view, "did_execution_drift", {
    status: drift ? "drift_detected" : complete ? "aligned" : "incomplete",
    reason: drift ? "runtime_topology_differs_from_intended" :
      complete ? "runtime_matches_intended_with_verified_outcome" : "runtime_evidence_is_incomplete",
    nodes: [...new Map(selectedNodes.map((node) => [node.nodeId, node])).values()],
    edges: selectedEdges,
    details: { missingAtRuntime, unexpectedAtRuntime, missingEvidence, outcomeCount: outcomes.length },
  });
}

export function explainProjectChanges(input) {
  const view = graphView(input);
  const plans = byNode(view, "plan", input.planId);
  if (plans.length !== 1) {
    return result(view, "what_changed_in_project", {
      status: "denied", reason: plans.length ? "plan_revision_is_ambiguous" : "plan_not_found",
    });
  }
  const plan = plans[0];
  const changedEdges = view.activeEdges.filter((edge) =>
    edge.from.nodeId === plan.nodeId && [
      "plan.produces_outcome", "plan.proposes_time_return", "plan.proposes_memory",
      "plan.supersedes_plan",
    ].includes(edge.edgeType)
  );
  const outcomeEdges = changedEdges.filter((edge) => edge.edgeType === "plan.produces_outcome");
  if (outcomeEdges.length !== 1) {
    return result(view, "what_changed_in_project", {
      status: "incomplete", reason: "verified_outcome_not_available",
      nodes: [plan], edges: changedEdges,
    });
  }
  const changedNodes = [plan, ...changedEdges.map((edge) => view.nodeMap.get(edge.to.nodeId)).filter(Boolean)];
  return result(view, "what_changed_in_project", {
    status: "evidence_complete", reason: "verified_project_changes_are_available",
    nodes: changedNodes, edges: changedEdges,
    details: {
      outcome: nodeSummary(view.nodeMap.get(outcomeEdges[0].to.nodeId)),
      timeReturns: changedEdges.filter((edge) => edge.edgeType === "plan.proposes_time_return")
        .map((edge) => nodeSummary(view.nodeMap.get(edge.to.nodeId))),
      memoryCandidates: changedEdges.filter((edge) => edge.edgeType === "plan.proposes_memory")
        .map((edge) => nodeSummary(view.nodeMap.get(edge.to.nodeId))),
      supersededPlans: changedEdges.filter((edge) => edge.edgeType === "plan.supersedes_plan")
        .map((edge) => nodeSummary(view.nodeMap.get(edge.to.nodeId))),
    },
  });
}

export function buildGovernedGraphExplanations({ tenantId, projectId, nodes, edges, plans = [], now, limits }) {
  const common = { tenantId, projectId, nodes, edges, now, ...limits };
  return plans.slice(0, limits?.maxResults ?? defaultLimits.maxResults).map((plan) => ({
    planId: plan.id,
    drift: explainExecutionDrift({ ...common, planId: plan.id }),
    changes: explainProjectChanges({ ...common, planId: plan.id }),
  }));
}

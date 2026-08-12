import { createHash } from "node:crypto";
import { capabilityCatalog, validateProjectManifest } from "./capability-policy.mjs";
import { memoryIsUsable } from "./memory-policy.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { validateWorkEvent, validateWorkTrigger, workTriggerMatchesEvent } from "./work-trigger.mjs";
import { validateWorkRecipe, workRecipeRevision } from "./work-recipe.mjs";

export const graphContractVersion = 1;

export const graphNodeTypes = Object.freeze([
  "approval",
  "audit",
  "authorization",
  "capability",
  "deliverable",
  "event",
  "evidence",
  "memory",
  "message",
  "outcome",
  "person",
  "plan",
  "project",
  "recipe",
  "source",
  "step",
  "task",
  "time_return",
  "trigger",
]);

const graphNodeTypeSet = new Set(graphNodeTypes);
const sensitivityRank = new Map([
  ["public", 0],
  ["internal", 1],
  ["confidential", 2],
]);

const edgeDefinitions = Object.freeze({
  "project.has_authorization": {
    from: ["project"], to: ["authorization"], phases: ["intended"], authorization: true,
  },
  "project.selects_recipe": {
    from: ["project"], to: ["recipe"], phases: ["intended"], authorization: true,
  },
  "event.matches_trigger": {
    from: ["event"], to: ["trigger"], phases: ["runtime"], authorization: true,
  },
  "trigger.instantiates_plan": {
    from: ["trigger"], to: ["plan"], phases: ["runtime"], authorization: true,
  },
  "task.requests_plan": {
    from: ["task"], to: ["plan"], phases: ["runtime"], authorization: true,
  },
  "plan.contains_step": {
    from: ["plan"], to: ["step"], phases: ["intended", "runtime"], authorization: true,
  },
  "recipe.instantiates_plan": {
    from: ["recipe"], to: ["plan"], phases: ["intended", "runtime"], authorization: true,
  },
  "authorization.grants_capability": {
    from: ["authorization"], to: ["capability"], phases: ["intended"], authorization: true,
  },
  "authorization.permits_step": {
    from: ["authorization"], to: ["step"], phases: ["intended"], authorization: true,
  },
  "step.uses_capability": {
    from: ["step"], to: ["capability"], phases: ["intended", "runtime"], authorization: true,
  },
  "approval.authorizes_plan": {
    from: ["approval"], to: ["plan"], phases: ["runtime"], authorization: true,
  },
  "step.produces_evidence": {
    from: ["step"], to: ["evidence"], phases: ["runtime"], authorization: true,
  },
  "plan.produces_outcome": {
    from: ["plan"], to: ["outcome"], phases: ["runtime"], authorization: true,
  },
  "source.supports_memory": {
    from: ["source"], to: ["memory"], phases: ["runtime"], authorization: false,
  },
  "memory.informs_plan": {
    from: ["memory"], to: ["plan"], phases: ["runtime"], authorization: true,
  },
  "plan.proposes_time_return": {
    from: ["plan"], to: ["time_return"], phases: ["runtime"], authorization: true,
  },
  "plan.proposes_memory": {
    from: ["plan"], to: ["memory"], phases: ["runtime"], authorization: true,
  },
  "plan.supersedes_plan": {
    from: ["plan"], to: ["plan"], phases: ["runtime"], authorization: true,
  },
});

export const graphEdgeTypes = Object.freeze(Object.keys(edgeDefinitions));

function object(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function text(value, name, maximum = 500) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function sha256(value, name) {
  const normalized = text(value, name, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function timestamp(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const date = value instanceof Date ? value : new Date(text(value, name, 100));
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a timestamp`);
  return date.toISOString();
}

function stableValue(value, name, depth = 0) {
  if (depth > 12) throw new Error(`${name} exceeds maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item, name, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} must contain JSON-compatible values`);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [text(key, `${name} key`, 200), stableValue(value[key], name, depth + 1)]),
  );
}

function digest(prefix, value) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(stableValue(value, prefix))).digest("hex")}`;
}

export function graphContentRevision(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value, "graph content")))
    .digest("hex");
}

function provenance(value) {
  const input = object(value, "provenance");
  return {
    recordType: text(input.recordType, "provenance.recordType", 100),
    recordId: text(input.recordId, "provenance.recordId", 500),
    recordVersion: text(input.recordVersion, "provenance.recordVersion", 500),
  };
}

function sensitivity(value, name = "sensitivity") {
  const normalized = text(value, name, 20);
  if (!sensitivityRank.has(normalized)) throw new Error(`${name} is unsupported`);
  return normalized;
}

function strictestSensitivity(...values) {
  return values
    .filter(Boolean)
    .map((value) => sensitivity(value))
    .sort((left, right) => sensitivityRank.get(right) - sensitivityRank.get(left))[0] ?? "internal";
}

function earliestTimestamp(...values) {
  const normalized = values.filter((value) => value != null).map((value) => timestamp(value, "expiresAt"));
  return normalized.sort()[0] ?? null;
}

function nodeInput(input) {
  const value = object(input, "graph node");
  const nodeType = text(value.nodeType, "nodeType", 100);
  if (!graphNodeTypeSet.has(nodeType)) throw new Error(`Unsupported graph node type: ${nodeType}`);
  const tenantId = text(value.tenantId, "tenantId", 200);
  const projectId = text(value.projectId, "projectId", 200);
  const domainId = text(value.domainId, "domainId", 500);
  const revision = text(value.revision, "revision", 500);
  const normalized = {
    graphVersion: graphContractVersion,
    tenantId,
    projectId,
    nodeType,
    domainId,
    revision,
    provenance: provenance(value.provenance),
    sensitivity: sensitivity(value.sensitivity ?? "internal"),
    expiresAt: timestamp(value.expiresAt, "expiresAt", { nullable: true }),
    observedAt: timestamp(value.observedAt, "observedAt"),
  };
  return {
    ...normalized,
    nodeKey: digest("node", { tenantId, projectId, nodeType, domainId }),
    nodeId: digest("nodev", { tenantId, projectId, nodeType, domainId, revision }),
  };
}

export function createGraphNode(input) {
  return nodeInput(input);
}

export function validateGraphNode(input) {
  const normalized = nodeInput(input);
  if (input.graphVersion !== graphContractVersion) {
    throw new Error(`graphVersion must be ${graphContractVersion}`);
  }
  if (input.nodeKey !== normalized.nodeKey || input.nodeId !== normalized.nodeId) {
    throw new Error("Graph node identity does not match its content");
  }
  return normalized;
}

function nodeReference(value, name) {
  try {
    const input = object(value, name);
    const normalized = input.provenance
      ? validateGraphNode(input)
      : {
          graphVersion: input.graphVersion,
          tenantId: text(input.tenantId, `${name}.tenantId`, 200),
          projectId: text(input.projectId, `${name}.projectId`, 200),
          nodeType: text(input.nodeType, `${name}.nodeType`, 100),
          domainId: text(input.domainId, `${name}.domainId`, 500),
          revision: text(input.revision, `${name}.revision`, 500),
          sensitivity: sensitivity(input.sensitivity, `${name}.sensitivity`),
          expiresAt: timestamp(input.expiresAt, `${name}.expiresAt`, { nullable: true }),
          nodeKey: text(input.nodeKey, `${name}.nodeKey`, 80),
          nodeId: text(input.nodeId, `${name}.nodeId`, 80),
        };
    if (normalized.graphVersion !== graphContractVersion) {
      throw new Error(`graphVersion must be ${graphContractVersion}`);
    }
    if (!graphNodeTypeSet.has(normalized.nodeType)) {
      throw new Error(`Unsupported graph node type: ${normalized.nodeType}`);
    }
    const expectedKey = digest("node", {
      tenantId: normalized.tenantId,
      projectId: normalized.projectId,
      nodeType: normalized.nodeType,
      domainId: normalized.domainId,
    });
    const expectedId = digest("nodev", {
      tenantId: normalized.tenantId,
      projectId: normalized.projectId,
      nodeType: normalized.nodeType,
      domainId: normalized.domainId,
      revision: normalized.revision,
    });
    if (normalized.nodeKey !== expectedKey || normalized.nodeId !== expectedId) {
      throw new Error("node identity does not match its content");
    }
    return {
      graphVersion: graphContractVersion,
      tenantId: normalized.tenantId,
      projectId: normalized.projectId,
      nodeType: normalized.nodeType,
      domainId: normalized.domainId,
      revision: normalized.revision,
      sensitivity: normalized.sensitivity,
      expiresAt: normalized.expiresAt,
      nodeKey: normalized.nodeKey,
      nodeId: normalized.nodeId,
    };
  } catch (error) {
    throw new Error(`${name} is invalid: ${error.message}`);
  }
}

function edgeInput(input) {
  const value = object(input, "graph edge");
  const edgeType = text(value.edgeType, "edgeType", 100);
  const definition = edgeDefinitions[edgeType];
  if (!definition) throw new Error(`Unsupported graph edge type: ${edgeType}`);
  const from = nodeReference(value.from, "from node");
  const to = nodeReference(value.to, "to node");
  if (!definition.from.includes(from.nodeType) || !definition.to.includes(to.nodeType)) {
    throw new Error(`${edgeType} does not allow ${from.nodeType} -> ${to.nodeType}`);
  }
  if (from.tenantId !== to.tenantId) throw new Error("Graph edges cannot cross tenants");
  if (from.projectId !== to.projectId) throw new Error("Graph edges cannot cross projects");
  const phase = text(value.phase, "phase", 20);
  if (!definition.phases.includes(phase)) throw new Error(`${edgeType} does not allow phase ${phase}`);
  const authorizationHash = value.authorizationHash == null
    ? null
    : sha256(value.authorizationHash, "authorizationHash");
  if (definition.authorization && !authorizationHash) {
    throw new Error(`${edgeType} requires an authorizationHash`);
  }
  if (
    edgeType === "authorization.permits_step" &&
    authorizationHash !== from.revision
  ) {
    throw new Error("Authorization edge must use the authorization node revision");
  }
  const observedAt = timestamp(value.observedAt, "observedAt");
  const validFrom = timestamp(value.validFrom ?? observedAt, "validFrom");
  const invalidatedAt = timestamp(value.invalidatedAt, "invalidatedAt", { nullable: true });
  if (invalidatedAt && (invalidatedAt < validFrom || invalidatedAt > observedAt)) {
    throw new Error("invalidatedAt must be between validFrom and observedAt");
  }
  const normalizedProvenance = provenance(value.provenance);
  const normalized = {
    graphVersion: graphContractVersion,
    edgeType,
    from,
    to,
    phase,
    provenance: normalizedProvenance,
    authorizationHash,
    sensitivity: strictestSensitivity(from.sensitivity, to.sensitivity, value.sensitivity),
    expiresAt: earliestTimestamp(from.expiresAt, to.expiresAt, value.expiresAt),
    validFrom,
    invalidatedAt,
    state: invalidatedAt ? "invalidated" : "active",
    observedAt,
  };
  const relationKey = digest("relation", {
    tenantId: from.tenantId,
    projectId: from.projectId,
    edgeType,
    from: from.nodeId,
    to: to.nodeId,
    phase,
    authorizationHash,
  });
  return {
    ...normalized,
    relationKey,
    edgeId: digest("edge", {
      relationKey,
      provenance: normalizedProvenance,
      validFrom,
      invalidatedAt,
      observedAt,
    }),
  };
}

export function createGraphEdge(input) {
  return edgeInput(input);
}

export function validateGraphEdge(input) {
  const normalized = edgeInput(input);
  if (input.graphVersion !== graphContractVersion) {
    throw new Error(`graphVersion must be ${graphContractVersion}`);
  }
  if (input.relationKey !== normalized.relationKey || input.edgeId !== normalized.edgeId) {
    throw new Error("Graph edge identity does not match its content");
  }
  return normalized;
}

export function buildGraphProjection({ nodes = [], edges = [] } = {}) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error("Graph projection nodes and edges must be arrays");
  }
  const nodeMap = new Map();
  for (const input of nodes) {
    const node = validateGraphNode(input);
    const existing = nodeMap.get(node.nodeId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(node)) {
      throw new Error(`Conflicting graph node revision: ${node.nodeId}`);
    }
    nodeMap.set(node.nodeId, node);
  }
  const edgeMap = new Map();
  for (const input of edges) {
    const edge = validateGraphEdge(input);
    if (!nodeMap.has(edge.from.nodeId) || !nodeMap.has(edge.to.nodeId)) {
      throw new Error(`Graph edge has a dangling endpoint: ${edge.edgeId}`);
    }
    const existing = edgeMap.get(edge.edgeId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(edge)) {
      throw new Error(`Conflicting graph edge observation: ${edge.edgeId}`);
    }
    edgeMap.set(edge.edgeId, edge);
  }
  return {
    graphVersion: graphContractVersion,
    nodes: [...nodeMap.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...edgeMap.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
  };
}

function rowValue(row, snake, camel = snake) {
  return row?.[snake] ?? row?.[camel] ?? null;
}

function nodeFactory({ tenantId, projectId, observedAt, nodes }) {
  return (input) => {
    const node = createGraphNode({ tenantId, projectId, observedAt, ...input });
    nodes.push(node);
    return node;
  };
}

function edgeFactory({ observedAt, edges, authorizationHash }) {
  return (input) => {
    const edge = createGraphEdge({ observedAt, authorizationHash, ...input });
    edges.push(edge);
    return edge;
  };
}

function record(recordType, recordId, recordVersion) {
  return { recordType, recordId: String(recordId), recordVersion: String(recordVersion) };
}

function assertPersistedPlan(workPlan, assessment) {
  if (!workPlan) return null;
  const id = text(workPlan.id, "workPlan.id", 200);
  const expectedId = `plan_${assessment.planHash.slice(0, 24)}`;
  if (id !== expectedId) throw new Error("Persisted work plan id does not match planHash");
  if (rowValue(workPlan, "project_id", "projectId") !== assessment.plan.projectId) {
    throw new Error("Persisted work plan project does not match the assessed plan");
  }
  if (rowValue(workPlan, "plan_hash", "planHash") !== assessment.planHash) {
    throw new Error("Persisted work plan hash does not match the assessment");
  }
  if (rowValue(workPlan, "authorization_hash", "authorizationHash") !== assessment.authorizationHash) {
    throw new Error("Persisted work plan authorization does not match the assessment");
  }
  return { ...workPlan, id };
}

function normalizePersistedSteps(plan, persistedSteps) {
  if (!Array.isArray(persistedSteps)) throw new Error("Persisted work plan steps must be an array");
  if (persistedSteps.length !== plan.steps.length) {
    throw new Error("Persisted work plan steps do not match the assessed plan");
  }
  return plan.steps.map((step, position) => {
    const row = persistedSteps.find((candidate) => rowValue(candidate, "step_id", "stepId") === step.id);
    if (
      !row ||
      Number(row.position) !== position ||
      row.capability !== step.capability
    ) {
      throw new Error(`Persisted step does not match assessed step: ${step.id}`);
    }
    return row;
  });
}

export function projectWorkPlanGraph({
  tenantId,
  manifest: manifestInput,
  assessment: assessmentInput,
  recipe: recipeInput = null,
  workPlan: workPlanInput = null,
  steps: persistedStepInputs = [],
  approval = null,
  sourceTask = null,
  trigger = null,
  triggerRun = null,
  event = null,
  memoriesUsed = [],
  memoriesProposed = [],
  timeReturn = null,
  observedAt,
}) {
  const observed = timestamp(observedAt, "observedAt");
  const manifest = validateProjectManifest(manifestInput);
  const assessment = assessWorkPlan({
    plan: assessmentInput?.plan,
    manifest,
    now: new Date(observed),
  });
  if (
    assessment.decision === "DENY" ||
    assessment.planHash !== assessmentInput?.planHash ||
    assessment.authorizationHash !== assessmentInput?.authorizationHash ||
    assessment.decision !== assessmentInput?.decision
  ) {
    throw new Error("Graph projection requires a current, executable work-plan assessment");
  }
  const workPlan = assertPersistedPlan(workPlanInput, assessment);
  const planId = workPlan?.id ?? `plan_${assessment.planHash.slice(0, 24)}`;
  if (assessment.plan.recipe && !recipeInput) {
    throw new Error("Recipe-bound plan requires the immutable recipe input");
  }
  if (workPlan && assessment.plan.sourceTaskId && !sourceTask) {
    throw new Error("Persisted source-bound plan requires its source task");
  }
  if (workPlan && assessment.plan.recipe?.triggerId && !trigger) {
    throw new Error("Triggered work plan requires its trigger run evidence");
  }
  if (
    workPlan &&
    assessment.decision === "REQUIRE_APPROVAL" &&
    ["approved", "executing", "verifying", "completed", "failed"].includes(workPlan.status) &&
    !approval
  ) {
    throw new Error("Executed approval-required plan requires its bound approval");
  }
  const nodes = [];
  const edges = [];
  const addNode = nodeFactory({
    tenantId: text(tenantId, "tenantId", 200),
    projectId: manifest.projectId,
    observedAt: observed,
    nodes,
  });
  const addEdge = edgeFactory({
    observedAt: observed,
    edges,
    authorizationHash: assessment.authorizationHash,
  });
  const projectNode = addNode({
    nodeType: "project",
    domainId: manifest.projectId,
    revision: assessment.authorizationHash,
    provenance: record("project_manifest", manifest.projectId, assessment.authorizationHash),
    sensitivity: "internal",
  });
  const authorizationNode = addNode({
    nodeType: "authorization",
    domainId: assessment.authorizationHash,
    revision: assessment.authorizationHash,
    provenance: record("project_manifest", manifest.projectId, assessment.authorizationHash),
    sensitivity: "confidential",
  });
  const planNode = addNode({
    nodeType: "plan",
    domainId: planId,
    revision: assessment.planHash,
    provenance: record("work_plan", planId, assessment.planHash),
    sensitivity: "internal",
  });
  addEdge({
    edgeType: "project.has_authorization",
    from: projectNode,
    to: authorizationNode,
    phase: "intended",
    provenance: record("project_manifest", manifest.projectId, assessment.authorizationHash),
  });

  if (recipeInput) {
    const recipe = validateWorkRecipe(recipeInput);
    if (
      assessment.plan.recipe?.id !== recipe.id ||
      !(manifest.profile?.selectedRecipeIds ?? []).includes(recipe.id) ||
      assessment.plan.recipe?.contentHash !== workRecipeRevision(recipe)
    ) {
      throw new Error("Recipe content is not immutably bound to the project and assessed plan");
    }
    const recipeRevision = workRecipeRevision(recipe);
    const recipeNode = addNode({
      nodeType: "recipe",
      domainId: recipe.id,
      revision: recipeRevision,
      provenance: record("work_recipe", recipe.id, recipeRevision),
      sensitivity: "internal",
    });
    addEdge({
      edgeType: "project.selects_recipe",
      from: projectNode,
      to: recipeNode,
      phase: "intended",
      provenance: record("project_manifest", manifest.projectId, assessment.authorizationHash),
    });
    addEdge({
      edgeType: "recipe.instantiates_plan",
      from: recipeNode,
      to: planNode,
      phase: "intended",
      provenance: record("assessed_work_plan", planId, assessment.planHash),
    });
    if (workPlan) {
      addEdge({
        edgeType: "recipe.instantiates_plan",
        from: recipeNode,
        to: planNode,
        phase: "runtime",
        provenance: record("work_plan", planId, assessment.planHash),
      });
    }
  }

  const persistedSteps = workPlan
    ? normalizePersistedSteps(assessment.plan, persistedStepInputs)
    : assessment.plan.steps.map(() => null);
  const stepNodes = new Map();
  const evidenceNodes = [];
  assessment.plan.steps.forEach((step, position) => {
    const rule = manifest.capabilities[step.capability];
    const capabilityExpiry = rule?.expiresAt ?? null;
    const capabilityRevision = graphContentRevision({
      definition: capabilityCatalog[step.capability],
      rule,
      authorizationHash: assessment.authorizationHash,
    });
    const capabilityNode = addNode({
      nodeType: "capability",
      domainId: `${manifest.projectId}:${step.capability}`,
      revision: capabilityRevision,
      provenance: record("project_manifest", manifest.projectId, assessment.authorizationHash),
      sensitivity: "confidential",
      expiresAt: capabilityExpiry,
    });
    const stepRevision = graphContentRevision(step);
    const stepNode = addNode({
      nodeType: "step",
      domainId: `${planId}:${step.id}`,
      revision: stepRevision,
      provenance: record("work_plan_step", `${planId}:${step.id}`, stepRevision),
      sensitivity: "internal",
    });
    stepNodes.set(step.id, stepNode);
    addEdge({
      edgeType: "authorization.grants_capability",
      from: authorizationNode,
      to: capabilityNode,
      phase: "intended",
      provenance: record("project_manifest", manifest.projectId, assessment.authorizationHash),
      expiresAt: capabilityExpiry,
    });
    addEdge({
      edgeType: "plan.contains_step",
      from: planNode,
      to: stepNode,
      phase: "intended",
      provenance: record("assessed_work_plan", planId, assessment.planHash),
    });
    addEdge({
      edgeType: "authorization.permits_step",
      from: authorizationNode,
      to: stepNode,
      phase: "intended",
      provenance: record("capability_policy", `${manifest.projectId}:${step.capability}`, capabilityRevision),
      expiresAt: capabilityExpiry,
    });
    addEdge({
      edgeType: "step.uses_capability",
      from: stepNode,
      to: capabilityNode,
      phase: "intended",
      provenance: record("assessed_work_plan", planId, assessment.planHash),
      expiresAt: capabilityExpiry,
    });
    if (!workPlan) return;
    const persisted = persistedSteps[position];
    const persistedVersion = graphContentRevision({
      position,
      capability: persisted.capability,
      status: persisted.status,
      updatedAt: rowValue(persisted, "updated_at", "updatedAt"),
    });
    addEdge({
      edgeType: "plan.contains_step",
      from: planNode,
      to: stepNode,
      phase: "runtime",
      provenance: record("work_plan_step", `${planId}:${step.id}`, persistedVersion),
    });
    addEdge({
      edgeType: "step.uses_capability",
      from: stepNode,
      to: capabilityNode,
      phase: "runtime",
      provenance: record("work_plan_step", `${planId}:${step.id}`, persistedVersion),
      expiresAt: capabilityExpiry,
    });
    if (persisted.status === "completed" && persisted.evidence) {
      const evidenceRevision = graphContentRevision(persisted.evidence);
      const evidenceNode = addNode({
        nodeType: "evidence",
        domainId: `${planId}:${step.id}`,
        revision: evidenceRevision,
        provenance: record("work_plan_step_evidence", `${planId}:${step.id}`, evidenceRevision),
        sensitivity: "internal",
      });
      evidenceNodes.push(evidenceNode);
      addEdge({
        edgeType: "step.produces_evidence",
        from: stepNode,
        to: evidenceNode,
        phase: "runtime",
        provenance: record("work_plan_step_evidence", `${planId}:${step.id}`, evidenceRevision),
      });
    }
  });

  if (workPlan && sourceTask) {
    if (sourceTask.id !== assessment.plan.sourceTaskId) {
      throw new Error("Source task does not match the assessed plan");
    }
    const sourceTaskVersion = graphContentRevision({
      id: sourceTask.id,
      status: sourceTask.status,
      updatedAt: rowValue(sourceTask, "updated_at", "updatedAt"),
    });
    const taskNode = addNode({
      nodeType: "task",
      domainId: sourceTask.id,
      revision: sourceTaskVersion,
      provenance: record("task", sourceTask.id, sourceTaskVersion),
      sensitivity: "confidential",
    });
    addEdge({
      edgeType: "task.requests_plan",
      from: taskNode,
      to: planNode,
      phase: "runtime",
      provenance: record("work_plan", planId, assessment.planHash),
    });
  }

  if (workPlan && approval) {
    const approvalVersion = Number(rowValue(approval, "approval_version", "approvalVersion"));
    const approvalPlanHash = rowValue(approval, "plan_hash", "planHash");
    const expiresAt = rowValue(approval, "expires_at", "expiresAt");
    if (
      approval.decision !== "approved" ||
      approvalPlanHash !== assessment.planHash ||
      approvalVersion !== Number(rowValue(workPlan, "approval_version", "approvalVersion")) ||
      !expiresAt ||
      (timestamp(expiresAt, "approval.expiresAt") <= observed && Number(approval.consumed ?? 0) < 1)
    ) {
      throw new Error("Approval is not valid for the current plan revision");
    }
    const approvalRevision = graphContentRevision({
      id: approval.id,
      planHash: approvalPlanHash,
      approvalVersion,
      decision: approval.decision,
      expiresAt: timestamp(expiresAt, "approval.expiresAt"),
    });
    const approvalNode = addNode({
      nodeType: "approval",
      domainId: text(approval.id, "approval.id", 200),
      revision: approvalRevision,
      provenance: record("work_plan_approval", approval.id, approvalRevision),
      sensitivity: "confidential",
      expiresAt,
    });
    addEdge({
      edgeType: "approval.authorizes_plan",
      from: approvalNode,
      to: planNode,
      phase: "runtime",
      provenance: record("work_plan_approval", approval.id, approvalRevision),
      expiresAt,
    });
  }

  if (workPlan && trigger) {
    const normalizedTrigger = validateWorkTrigger(trigger);
    const recipeBinding = assessment.plan.recipe;
    const runKey = recipeBinding?.triggerRunKey;
    if (
      normalizedTrigger.id !== recipeBinding?.triggerId ||
      normalizedTrigger.projectId !== manifest.projectId ||
      !triggerRun ||
      rowValue(triggerRun, "trigger_id", "triggerId") !== normalizedTrigger.id ||
      rowValue(triggerRun, "run_key", "runKey") !== runKey ||
      rowValue(triggerRun, "work_plan_id", "workPlanId") !== planId ||
      triggerRun.status !== "completed"
    ) {
      throw new Error("Trigger run is not bound to the persisted work plan");
    }
    const triggerRevision = graphContentRevision(normalizedTrigger);
    const triggerNode = addNode({
      nodeType: "trigger",
      domainId: normalizedTrigger.id,
      revision: triggerRevision,
      provenance: record("work_trigger", normalizedTrigger.id, triggerRevision),
      sensitivity: "confidential",
    });
    addEdge({
      edgeType: "trigger.instantiates_plan",
      from: triggerNode,
      to: planNode,
      phase: "runtime",
      provenance: record("work_trigger_run", runKey, runKey),
    });
    if (event) {
      const normalizedEvent = validateWorkEvent(event);
      if (normalizedTrigger.kind !== "event" || !workTriggerMatchesEvent(normalizedTrigger, normalizedEvent)) {
        throw new Error("Work event does not match the persisted trigger run");
      }
      const eventRevision = graphContentRevision(normalizedEvent);
      const eventNode = addNode({
        nodeType: "event",
        domainId: normalizedEvent.id,
        revision: eventRevision,
        provenance: record("work_event", normalizedEvent.id, eventRevision),
        sensitivity: "confidential",
      });
      addEdge({
        edgeType: "event.matches_trigger",
        from: eventNode,
        to: triggerNode,
        phase: "runtime",
        provenance: record("work_trigger_run", runKey, runKey),
      });
    }
  }

  for (const memory of memoriesUsed) {
    if (
      memory.project_id !== manifest.projectId ||
      !memoryIsUsable(memory, new Date(observed))
    ) {
      throw new Error("Only usable memories from the same project may inform a plan");
    }
    const memoryRevision = graphContentRevision({
      statement: memory.statement,
      sourceType: memory.source_type,
      sourceId: memory.source_id,
      sourceVersion: memory.source_version,
      sourceAccessStatus: memory.source_access_status,
      sourceAccessExpiresAt: memory.source_access_expires_at,
      scope: memory.scope,
      sensitivity: memory.sensitivity,
      expiresAt: memory.expires_at,
      updatedAt: memory.updated_at,
    });
    const memoryNode = addNode({
      nodeType: "memory",
      domainId: text(memory.id, "memory.id", 200),
      revision: memoryRevision,
      provenance: record("memory_item", memory.id, memoryRevision),
      sensitivity: memory.sensitivity,
      expiresAt: memory.expires_at,
    });
    const sourceKey = graphContentRevision({ type: memory.source_type, id: memory.source_id });
    const sourceRecordVersion = memory.source_version || sourceKey;
    const sourceExpiresAt = earliestTimestamp(memory.expires_at, memory.source_access_expires_at);
    const sourceRevision = graphContentRevision({
      sourceVersion: sourceRecordVersion,
      sourceAccessStatus: memory.source_access_status,
      sourceAccessExpiresAt: memory.source_access_expires_at,
      sensitivity: memory.sensitivity,
      expiresAt: sourceExpiresAt,
    });
    const sourceNode = addNode({
      nodeType: "source",
      domainId: sourceKey,
      revision: sourceRevision,
      provenance: record(memory.source_type, sourceKey, sourceRecordVersion),
      sensitivity: memory.sensitivity,
      expiresAt: sourceExpiresAt,
    });
    addEdge({
      edgeType: "source.supports_memory",
      from: sourceNode,
      to: memoryNode,
      phase: "runtime",
      authorizationHash: null,
      provenance: record("memory_item", memory.id, memoryRevision),
    });
    addEdge({
      edgeType: "memory.informs_plan",
      from: memoryNode,
      to: planNode,
      phase: "runtime",
      provenance: record("planning_context", planId, assessment.planHash),
    });
  }

  for (const memory of memoriesProposed) {
    if (
      memory.project_id !== manifest.projectId ||
      memory.source_type !== "work_plan" ||
      memory.source_id !== assessment.planHash ||
      !["proposed", "confirmed", "revoked"].includes(memory.status)
    ) {
      throw new Error("Proposed project memory is not bound to this work plan");
    }
    const memoryRevision = graphContentRevision({
      statement: memory.statement,
      sourceType: memory.source_type,
      sourceId: memory.source_id,
      sourceVersion: memory.source_version,
      scope: memory.scope,
      status: memory.status,
      sensitivity: memory.sensitivity,
      expiresAt: memory.expires_at,
      updatedAt: memory.updated_at,
    });
    const memoryNode = addNode({
      nodeType: "memory",
      domainId: text(memory.id, "memory.id", 200),
      revision: memoryRevision,
      provenance: record("memory_item", memory.id, memoryRevision),
      sensitivity: memory.sensitivity,
      expiresAt: memory.expires_at,
    });
    addEdge({
      edgeType: "plan.proposes_memory",
      from: planNode,
      to: memoryNode,
      phase: "runtime",
      provenance: record("memory_item", memory.id, memoryRevision),
    });
  }

  const workPlanStatus = workPlan?.status;
  const allStepsVerified = workPlan && persistedSteps.length > 0 &&
    persistedSteps.every((step) => step.status === "completed" && step.evidence);
  let outcomeNode = null;
  if (workPlanStatus === "completed" && allStepsVerified) {
    const outcomeRevision = graphContentRevision({
      planHash: assessment.planHash,
      evidence: evidenceNodes.map((node) => node.revision).sort(),
      status: workPlanStatus,
    });
    outcomeNode = addNode({
      nodeType: "outcome",
      domainId: planId,
      revision: outcomeRevision,
      provenance: record("work_plan_outcome", planId, outcomeRevision),
      sensitivity: "internal",
    });
    addEdge({
      edgeType: "plan.produces_outcome",
      from: planNode,
      to: outcomeNode,
      phase: "runtime",
      provenance: record("work_plan_outcome", planId, outcomeRevision),
    });
  } else if (workPlanStatus === "completed") {
    throw new Error("Completed work plan cannot project an outcome without evidence for every step");
  }

  if (timeReturn) {
    if (
      !outcomeNode ||
      timeReturn.workPlanId !== planId ||
      timeReturn.projectId !== manifest.projectId ||
      !["proposed", "confirmed", "rejected"].includes(timeReturn.status)
    ) {
      throw new Error("Time return is not bound to a verified work-plan outcome");
    }
    const timeReturnRevision = graphContentRevision(timeReturn);
    const timeReturnNode = addNode({
      nodeType: "time_return",
      domainId: text(timeReturn.id, "timeReturn.id", 200),
      revision: timeReturnRevision,
      provenance: record("time_return_entry", timeReturn.id, timeReturnRevision),
      sensitivity: "internal",
    });
    addEdge({
      edgeType: "plan.proposes_time_return",
      from: planNode,
      to: timeReturnNode,
      phase: "runtime",
      provenance: record("time_return_entry", timeReturn.id, timeReturnRevision),
    });
  }

  return buildGraphProjection({ nodes, edges });
}

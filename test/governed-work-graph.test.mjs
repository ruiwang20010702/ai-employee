import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildGraphProjection,
  createGraphEdge,
  createGraphNode,
  graphEdgeTypes,
  graphNodeTypes,
  graphContentRevision,
  projectWorkPlanGraph,
  validateGraphEdge,
  validateGraphNode,
} from "../src/governed-work-graph.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import { instantiateWorkRecipe, validateWorkRecipe, workRecipeRevision } from "../src/work-recipe.mjs";

const observedAt = "2026-08-12T08:00:00.000Z";
const tenantId = "tenant_graph_test";

const manifest = {
  version: 1,
  projectId: "project_1",
  name: "项目一",
  rootDirectory: "/workspace/project",
  requesters: ["owner"],
  profile: {
    objective: "交付项目",
    successCriteria: ["完成验收"],
    milestones: ["首个闭环"],
    collaborationObjects: ["负责人"],
    selectedRecipeIds: ["project-follow-up"],
    memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
  },
  capabilities: {
    research: { mode: "automatic", expiresAt: "2026-09-01T00:00:00.000Z" },
    document_draft: { mode: "automatic" },
  },
};

const recipe = validateWorkRecipe(JSON.parse(await readFile(
  new URL("../deploy/recipes/project-follow-up.json", import.meta.url),
  "utf8",
)));

function assessedPlan() {
  return assessWorkPlan({
    manifest,
    plan: instantiateWorkRecipe(recipe, {
      projectId: manifest.projectId,
      requesterId: "owner",
      sourceTaskId: "task-1",
      projectRoot: manifest.rootDirectory,
      values: { projectFocus: "完成上线检查" },
    }).plan,
    now: new Date(observedAt),
  });
}

function completedFixture() {
  const assessment = assessedPlan();
  const id = `plan_${assessment.planHash.slice(0, 24)}`;
  return {
    assessment,
    workPlan: {
      id,
      project_id: manifest.projectId,
      plan_hash: assessment.planHash,
      authorization_hash: assessment.authorizationHash,
      approval_version: 1,
      status: "completed",
    },
    sourceTask: {
      id: "task-1",
      status: "completed",
      updated_at: "2026-08-12T07:20:00.000Z",
    },
    steps: assessment.plan.steps.map((step, position) => ({
      work_plan_id: id,
      step_id: step.id,
      position,
      capability: step.capability,
      status: "completed",
      evidence: {
        kind: `${step.capability}_evidence`,
        verification: "target_readback",
        sha256: graphContentRevision({ step: step.id, result: "verified" }),
      },
      updated_at: "2026-08-12T07:50:00.000Z",
    })),
  };
}

function projection(overrides = {}) {
  const fixture = completedFixture();
  return projectWorkPlanGraph({
    tenantId,
    manifest,
    recipe,
    observedAt,
    ...fixture,
    ...overrides,
  });
}

test("Graph Contract 节点与关系身份由规范内容确定且可防篡改", () => {
  const base = {
    tenantId,
    projectId: "project_1",
    nodeType: "project",
    domainId: "project_1",
    revision: "revision-1",
    provenance: { recordType: "project_manifest", recordId: "project_1", recordVersion: "revision-1" },
    sensitivity: "internal",
    observedAt,
  };
  const first = createGraphNode(base);
  const reordered = createGraphNode({
    observedAt,
    sensitivity: "internal",
    provenance: { recordVersion: "revision-1", recordId: "project_1", recordType: "project_manifest" },
    revision: "revision-1",
    domainId: "project_1",
    nodeType: "project",
    projectId: "project_1",
    tenantId,
  });
  assert.deepEqual(first, reordered);
  assert.deepEqual(validateGraphNode(first), first);
  assert.throws(() => validateGraphNode({ ...first, revision: "tampered" }), /identity does not match/u);
});

test("关系白名单拒绝跨租户、跨项目、错误方向和缺失授权", () => {
  const node = (nodeType, projectId = "project_1", tenant = tenantId) => createGraphNode({
    tenantId: tenant,
    projectId,
    nodeType,
    domainId: `${nodeType}-1`,
    revision: "revision-1",
    provenance: { recordType: nodeType, recordId: `${nodeType}-1`, recordVersion: "revision-1" },
    sensitivity: "internal",
    observedAt,
  });
  const plan = node("plan");
  const step = node("step");
  assert.throws(() => createGraphEdge({
    edgeType: "plan.contains_step", from: plan, to: step, phase: "intended",
    provenance: { recordType: "plan", recordId: "plan-1", recordVersion: "revision-1" },
    observedAt,
  }), /requires an authorizationHash/u);
  const auth = "a".repeat(64);
  const edge = createGraphEdge({
    edgeType: "plan.contains_step", from: plan, to: step, phase: "intended",
    authorizationHash: auth,
    provenance: { recordType: "plan", recordId: "plan-1", recordVersion: "revision-1" },
    observedAt,
  });
  assert.deepEqual(validateGraphEdge(edge), edge);
  assert.throws(() => createGraphEdge({ ...edge, from: node("plan", "other") }), /cross projects/u);
  assert.throws(() => createGraphEdge({ ...edge, from: node("plan", "project_1", "other") }), /cross tenants/u);
  assert.throws(() => createGraphEdge({ ...edge, from: step, to: plan }), /does not allow/u);
});

test("关系继承最严格敏感度和最早有效期且撤销形成新观察", () => {
  const from = createGraphNode({
    tenantId, projectId: "project_1", nodeType: "source", domainId: "source-1", revision: "v1",
    provenance: { recordType: "message", recordId: "m1", recordVersion: "v1" },
    sensitivity: "confidential", expiresAt: "2026-08-20T00:00:00.000Z", observedAt,
  });
  const to = createGraphNode({
    tenantId, projectId: "project_1", nodeType: "memory", domainId: "memory-1", revision: "v1",
    provenance: { recordType: "memory_item", recordId: "memory-1", recordVersion: "v1" },
    sensitivity: "internal", expiresAt: "2026-08-18T00:00:00.000Z", observedAt,
  });
  const active = createGraphEdge({
    edgeType: "source.supports_memory", from, to, phase: "runtime",
    authorizationHash: null,
    provenance: { recordType: "memory_item", recordId: "memory-1", recordVersion: "v1" },
    observedAt,
  });
  const invalidated = createGraphEdge({
    ...active,
    observedAt: "2026-08-13T08:00:00.000Z",
    invalidatedAt: "2026-08-13T08:00:00.000Z",
  });
  assert.equal(active.sensitivity, "confidential");
  assert.equal(active.expiresAt, "2026-08-18T00:00:00.000Z");
  assert.equal(invalidated.relationKey, active.relationKey);
  assert.notEqual(invalidated.edgeId, active.edgeId);
  assert.equal(invalidated.state, "invalidated");
});

test("纯投影完整连接项目、授权、配方、计划、步骤、证据和结果", () => {
  const graph = projection();
  const edgeTypes = new Set(graph.edges.map((edge) => edge.edgeType));
  for (const expected of [
    "project.has_authorization",
    "project.selects_recipe",
    "recipe.instantiates_plan",
    "plan.contains_step",
    "authorization.grants_capability",
    "authorization.permits_step",
    "step.uses_capability",
    "task.requests_plan",
    "step.produces_evidence",
    "plan.produces_outcome",
  ]) {
    assert.equal(edgeTypes.has(expected), true, expected);
  }
  assert.equal(graph.nodes.some((node) => node.nodeType === "outcome"), true);
  assert.equal(JSON.stringify(graph).includes("完成上线检查"), false);
});

test("同一领域夹具重复投影完全相同且合并不产生重复记录", () => {
  const first = projection();
  const second = projection();
  assert.deepEqual(second, first);
  assert.deepEqual(buildGraphProjection({
    nodes: [...first.nodes, ...second.nodes],
    edges: [...first.edges, ...second.edges],
  }), first);
});

test("SQLite 与 PostgreSQL 行命名形态生成完全相同的图记录", () => {
  const fixture = completedFixture();
  const sqlite = projection();
  const postgresShape = projectWorkPlanGraph({
    tenantId,
    manifest,
    recipe,
    observedAt,
    assessment: fixture.assessment,
    workPlan: {
      id: fixture.workPlan.id,
      projectId: fixture.workPlan.project_id,
      planHash: fixture.workPlan.plan_hash,
      authorizationHash: fixture.workPlan.authorization_hash,
      approvalVersion: fixture.workPlan.approval_version,
      status: fixture.workPlan.status,
    },
    sourceTask: {
      id: fixture.sourceTask.id,
      status: fixture.sourceTask.status,
      updatedAt: fixture.sourceTask.updated_at,
    },
    steps: fixture.steps.map((step) => ({
      workPlanId: step.work_plan_id,
      stepId: step.step_id,
      position: step.position,
      capability: step.capability,
      status: step.status,
      evidence: step.evidence,
      updatedAt: step.updated_at,
    })),
  });
  assert.deepEqual(postgresShape, sqlite);
});

test("项目授权变化、配方漂移和数据库计划身份不一致均失败关闭", () => {
  const fixture = completedFixture();
  const tightened = structuredClone(manifest);
  tightened.capabilities.research.mode = "disabled";
  assert.throws(() => projectWorkPlanGraph({
    tenantId, manifest: tightened, recipe, observedAt, ...fixture,
  }), /current, executable/u);
  const changedRecipe = structuredClone(recipe);
  changedRecipe.description = "被修改的配方";
  assert.throws(() => projectWorkPlanGraph({
    tenantId, manifest, recipe: changedRecipe, observedAt, ...fixture,
  }), /immutably bound/u);
  assert.throws(() => projectWorkPlanGraph({
    tenantId, manifest, recipe, observedAt,
    ...fixture,
    workPlan: { ...fixture.workPlan, authorization_hash: "b".repeat(64) },
  }), /authorization does not match/u);
});

test("缺少来源任务、审批或完整回读证据时不能补画执行事实", () => {
  const fixture = completedFixture();
  assert.throws(() => projectWorkPlanGraph({
    tenantId, manifest, recipe, observedAt, ...fixture, sourceTask: null,
  }), /requires its source task/u);
  const approvalManifest = structuredClone(manifest);
  approvalManifest.capabilities.research.mode = "approval_required";
  const approvalPlan = assessWorkPlan({ manifest: approvalManifest, plan: fixture.assessment.plan, now: new Date(observedAt) });
  const approvalId = `plan_${approvalPlan.planHash.slice(0, 24)}`;
  assert.throws(() => projectWorkPlanGraph({
    tenantId,
    manifest: approvalManifest,
    recipe,
    observedAt,
    assessment: approvalPlan,
    sourceTask: fixture.sourceTask,
    workPlan: {
      ...fixture.workPlan,
      id: approvalId,
      plan_hash: approvalPlan.planHash,
      authorization_hash: approvalPlan.authorizationHash,
    },
    steps: approvalPlan.plan.steps.map((step, position) => ({
      ...fixture.steps[position], work_plan_id: approvalId, step_id: step.id, capability: step.capability,
    })),
  }), /requires its bound approval/u);
  const missingEvidence = structuredClone(fixture.steps);
  missingEvidence[0].evidence = null;
  assert.throws(() => projection({ steps: missingEvidence }), /without evidence for every step/u);
});

test("只有同项目、可用且未过期的明确记忆版本可以形成 informs 边", () => {
  const memory = {
    id: "memory-1",
    project_id: manifest.projectId,
    status: "confirmed",
    statement: "负责人确认按当前范围交付",
    source_type: "gbrain",
    source_id: "projects/project-1/decision",
    source_version: "page-v2",
    source_access_status: "verified",
    source_access_expires_at: "2026-08-15T00:00:00.000Z",
    scope: { factKey: "project.decision.scope" },
    sensitivity: "internal",
    expires_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-12T07:00:00.000Z",
  };
  const graph = projection({ memoriesUsed: [memory] });
  assert.equal(graph.edges.some((edge) => edge.edgeType === "source.supports_memory"), true);
  assert.equal(graph.edges.some((edge) => edge.edgeType === "memory.informs_plan"), true);
  assert.equal(JSON.stringify(graph).includes(memory.statement), false);
  assert.throws(() => projection({ memoriesUsed: [{ ...memory, project_id: "other" }] }), /same project/u);
  assert.throws(() => projection({ memoriesUsed: [{ ...memory, source_access_expires_at: observedAt }] }), /Only usable memories/u);
});

test("时间返还只连接已经具备完整回读证据的计划结果", () => {
  const fixture = completedFixture();
  const timeReturn = {
    id: "time-1",
    workPlanId: fixture.workPlan.id,
    projectId: manifest.projectId,
    recipeId: recipe.id,
    baselineMinutes: 60,
    humanActiveMinutes: 10,
    returnedMinutes: 50,
    baselineMethod: "user_confirmed",
    outcomeEvidence: { verification: "target_readback" },
    status: "confirmed",
  };
  const graph = projection({ timeReturn });
  assert.equal(graph.edges.some((edge) => edge.edgeType === "plan.proposes_time_return"), true);
  assert.throws(() => projection({ timeReturn: { ...timeReturn, projectId: "other" } }), /verified work-plan outcome/u);
});

test("配方内容哈希绑定进入计划，修改配方正文会产生不同计划审批哈希", () => {
  const first = instantiateWorkRecipe(recipe, {
    projectId: manifest.projectId,
    requesterId: "owner",
    sourceTaskId: "task-1",
    projectRoot: manifest.rootDirectory,
    values: { projectFocus: "完成上线检查" },
  });
  const changed = structuredClone(recipe);
  changed.description = "同一编号但内容已经改变";
  const second = instantiateWorkRecipe(changed, {
    projectId: manifest.projectId,
    requesterId: "owner",
    sourceTaskId: "task-1",
    projectRoot: manifest.rootDirectory,
    values: { projectFocus: "完成上线检查" },
  });
  assert.equal(first.plan.recipe.contentHash, workRecipeRevision(recipe));
  assert.notEqual(first.plan.recipe.contentHash, second.plan.recipe.contentHash);
  assert.notEqual(
    assessWorkPlan({ plan: first.plan, manifest }).planHash,
    assessWorkPlan({ plan: second.plan, manifest }).planHash,
  );
});

test("公开 JSON Schema 与运行时节点和关系枚举保持一致", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/governed-work-graph.schema.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    [...schema.$defs.node.properties.nodeType.enum].sort(),
    [...graphNodeTypes].sort(),
  );
  assert.deepEqual(
    [...schema.$defs.edge.properties.edgeType.enum].sort(),
    [...graphEdgeTypes].sort(),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.node.additionalProperties, false);
  assert.equal(schema.$defs.edge.additionalProperties, false);
  assert.equal(schema.$defs.nodeReference.additionalProperties, false);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import { captureWorkPlanGraph } from "../src/governed-work-graph-runtime.mjs";
import { explainExecutionDrift } from "../src/governed-work-graph-query.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "foursday-graph-runtime-"));
  const store = await new Store(join(directory, "runtime.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function manifest(mode = "automatic") {
  return {
    version: 1,
    projectId: "graph_runtime",
    name: "图运行测试",
    rootDirectory: "/workspace/graph-runtime",
    requesters: ["owner"],
    capabilities: { research: { mode } },
  };
}

function assessment(project = manifest()) {
  return assessWorkPlan({
    manifest: project,
    plan: {
      version: 1,
      projectId: project.projectId,
      requesterId: "owner",
      objective: "形成可验证研究结论",
      steps: [{
        id: "research",
        capability: "research",
        description: "研究现状",
        inputs: {},
        expectedEvidence: "带来源结论",
      }],
    },
  });
}

test("计划注册和完成可重复采集为设计图与运行图", async (t) => {
  const store = await fixture(t);
  const project = manifest();
  const assessed = assessment(project);
  const plan = store.registerWorkPlan(assessed, new Date("2026-08-12T08:00:00.000Z"));
  const first = await captureWorkPlanGraph({
    store, tenantId: "tenant-runtime", manifest: project, assessment: assessed,
    workPlan: plan, observedAt: "2026-08-12T08:00:01.000Z",
  });
  assert.equal(first.captured, true);
  assert.ok(first.insertedEdges > 0);
  store.consumeWorkPlanAuthorization(plan.id, new Date("2026-08-12T08:00:02.000Z"));
  store.updateWorkPlanStep(plan.id, "research", {
    status: "completed",
    evidence: { kind: "research_report", verified: true, sources: ["source-1"] },
  }, new Date("2026-08-12T08:00:03.000Z"));
  store.finishWorkPlan(plan.id, { success: true }, new Date("2026-08-12T08:00:04.000Z"));
  const second = await captureWorkPlanGraph({
    store, tenantId: "tenant-runtime", manifest: project,
    workPlan: store.getWorkPlan(plan.id), observedAt: "2026-08-12T08:00:05.000Z",
  });
  assert.equal(second.captured, true);
  const retry = await captureWorkPlanGraph({
    store, tenantId: "tenant-runtime", manifest: project,
    workPlan: store.getWorkPlan(plan.id), observedAt: "2026-08-12T08:00:05.000Z",
  });
  assert.equal(retry.insertedNodes, 0);
  assert.equal(retry.insertedEdges, 0);
  const nodes = store.listGraphNodes({
    tenantId: "tenant-runtime", projectId: project.projectId, limit: 500,
  });
  const edges = store.listGraphEdges({
    tenantId: "tenant-runtime", projectId: project.projectId, limit: 500,
  });
  const explanation = explainExecutionDrift({
    tenantId: "tenant-runtime", projectId: project.projectId,
    nodes, edges, planId: plan.id, now: "2026-08-12T08:00:05.000Z",
    maxResults: 500,
  });
  assert.equal(explanation.status, "aligned");
  assert.equal(edges.some((edge) => edge.phase === "intended"), true);
  assert.equal(edges.some((edge) => edge.edgeType === "plan.produces_outcome"), true);
});

test("已消费审批在到期后仍可作为历史执行证据但不能重新授权", async (t) => {
  const store = await fixture(t);
  const project = manifest("approval_required");
  const assessed = assessment(project);
  const plan = store.registerWorkPlan(assessed, new Date("2026-08-12T08:10:00.000Z"));
  store.decideWorkPlan(plan.id, {
    decision: "approved",
    actor: "owner",
    expiresAt: "2026-08-12T08:10:02.000Z",
  }, new Date("2026-08-12T08:10:01.000Z"));
  store.consumeWorkPlanAuthorization(plan.id, new Date("2026-08-12T08:10:01.500Z"));
  store.updateWorkPlanStep(plan.id, "research", {
    status: "completed", evidence: { verified: true, kind: "research_report" },
  }, new Date("2026-08-12T08:10:03.000Z"));
  store.finishWorkPlan(plan.id, { success: true }, new Date("2026-08-12T08:10:04.000Z"));
  const captured = await captureWorkPlanGraph({
    store,
    tenantId: "tenant-runtime",
    manifest: project,
    workPlan: store.getWorkPlan(plan.id),
    observedAt: "2026-08-12T08:10:05.000Z",
  });
  assert.equal(captured.captured, true);
  assert.equal(store.listGraphEdges({
    tenantId: "tenant-runtime",
    projectId: project.projectId,
    edgeType: "approval.authorizes_plan",
  }).length, 1);
  assert.throws(
    () => store.consumeWorkPlanAuthorization(plan.id, new Date("2026-08-12T08:10:06.000Z")),
    /not authorized/u,
  );
});

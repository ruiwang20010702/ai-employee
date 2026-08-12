import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectDashboard } from "../src/project-dashboard.mjs";
import { graphFixture } from "./support/governed-work-graph-fixture.mjs";

test("项目驾驶舱聚合计划、记忆、配方和已确认返还时间", () => {
  const dashboard = buildProjectDashboard({
    manifest: {
      projectId: "project_1",
      name: "项目一",
      profile: {
        objective: "完成项目",
        successCriteria: ["通过验收"],
        milestones: ["首个配方"],
        collaborationObjects: ["产品负责人"],
        selectedRecipeIds: ["daily-report"],
      },
    },
    plans: [
      { id: "plan-1", objective: "交付方案", project_id: "project_1", status: "completed", updated_at: "2026-08-12T01:00:00Z", plan: { recipe: { id: "daily-report", baselineMinutes: 60 } } },
      { id: "plan-2", objective: "跟进风险", project_id: "project_1", status: "executing", updated_at: "2026-08-12T02:00:00Z", plan: {} },
      { project_id: "other", status: "failed", updated_at: "2026-08-12T03:00:00Z" },
    ],
    memories: [
      { id: "memory-1", project_id: "project_1", status: "confirmed", statement: "负责人已确认", updated_at: "2026-08-12T01:00:00Z", scope: { factKey: "project.decision.owner" } },
      { project_id: "project_1", status: "proposed", scope: { factKey: "project.risk" } },
    ],
    timeReturns: [{ projectId: "project_1", returnedMinutes: 60, status: "confirmed" }],
    recipes: [{ id: "daily-report", name: "日报" }, { id: "code-delivery", name: "代码" }],
    planSteps: new Map([["plan-1", [{
      step_id: "draft", capability: "document_draft", status: "completed",
      evidence: { kind: "document_markdown", sha256: "a".repeat(64), verification: "nonempty" },
    }]]]),
  });
  assert.equal(dashboard.plans.total, 2);
  assert.equal(dashboard.plans.active, 1);
  assert.equal(dashboard.memory.confirmed, 1);
  assert.equal(dashboard.memory.decisions, 1);
  assert.deepEqual(dashboard.recipes.map((recipe) => recipe.id), ["daily-report"]);
  assert.equal(dashboard.timeReturn.returnedHours, 1);
  assert.equal(dashboard.plans.items[0].id, "plan-2");
  assert.equal(dashboard.deliverables[0].reference, "a".repeat(64));
  assert.equal(dashboard.memory.items[0].statement, "负责人已确认");
  assert.equal(dashboard.governedGraph.available, false);
});

test("项目驾驶舱只读呈现受治理工作图的对齐和变化解释", () => {
  const fixture = graphFixture();
  const dashboard = buildProjectDashboard({
    manifest: {
      projectId: fixture.scope.projectId,
      name: "图查询项目",
      profile: { objective: "完成可解释交付" },
    },
    plans: [{
      id: fixture.planId,
      objective: "完成交付",
      project_id: fixture.scope.projectId,
      status: "completed",
      updated_at: fixture.observedAt,
      plan: {},
    }],
    graph: {
      tenantId: fixture.scope.tenantId,
      nodes: fixture.graph.nodes,
      edges: fixture.graph.edges,
      now: fixture.observedAt,
    },
  });
  assert.equal(dashboard.governedGraph.available, true);
  assert.equal(dashboard.governedGraph.contractVersion, 1);
  assert.equal(dashboard.governedGraph.alignedPlans, 1);
  assert.equal(dashboard.governedGraph.driftedPlans, 0);
  assert.equal(dashboard.plans.items[0].graph.driftStatus, "aligned");
  assert.equal(dashboard.plans.items[0].graph.changeStatus, "evidence_complete");
});

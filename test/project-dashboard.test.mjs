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
      capabilities: {
        project_memory_proposal: {
          mode: "automatic",
          autoConfirm: true,
          sourcePaths: ["README.md", "docs/decisions.md"],
          allowedFactKeyPrefixes: ["decision.", "risk."],
          maxRetentionDays: 90,
        },
      },
    },
    plans: [
      { id: "plan-1", objective: "交付方案", project_id: "project_1", status: "completed", updated_at: "2026-08-12T01:00:00Z", plan: { recipe: { id: "daily-report", baselineMinutes: 60 } } },
      { id: "plan-2", objective: "跟进风险", project_id: "project_1", status: "executing", updated_at: "2026-08-12T02:00:00Z", plan: {} },
      { project_id: "other", status: "failed", updated_at: "2026-08-12T03:00:00Z" },
    ],
    memories: [
      { id: "memory-1", project_id: "project_1", status: "confirmed", statement: "负责人已确认", updated_at: "2026-08-12T01:00:00Z", scope: { factKey: "project.decision.owner" } },
      { id: "memory-2", project_id: "project_1", status: "proposed", source_type: "historical_project_import", statement: "负责人未确认", scope: { factKey: "project.decision.owner" } },
      { id: "memory-3", project_id: "project_1", status: "proposed", source_type: "historical_project_import", statement: "供应商交付可能延期", scope: { factKey: "risk.vendor" } },
      { id: "memory-4", project_id: "project_1", status: "confirmed", statement: "供应商交付可能延期", scope: { factKey: "risk.vendor" } },
      { id: "memory-other", project_id: "other", status: "proposed", statement: "不得跨项目显示", scope: { factKey: "risk.other" } },
    ],
    timeReturns: [{
      projectId: "project_1", baselineMinutes: 90, humanActiveMinutes: 30,
      returnedMinutes: 60, status: "confirmed", sourceType: "shadow_evidence",
      updatedAt: "2026-08-12T02:30:00Z",
    }],
    recipes: [{ id: "daily-report", name: "日报" }, { id: "code-delivery", name: "代码" }],
    planSteps: new Map([["plan-1", [{
      step_id: "draft", capability: "document_draft", status: "completed",
      evidence: {
        kind: "document_markdown", content: "# 已完成的交付草稿", bytes: 28,
        sha256: "a".repeat(64), verification: "nonempty",
      },
    }]]]),
    memorySyncState: {
      state: "review_required",
      lastCheckedAt: "2026-08-13T01:00:00.000Z",
      lastSuccessAt: "2026-08-13T01:00:00.000Z",
      sourceDigest: "a".repeat(64),
      candidatesCreated: 1,
      memoriesConfirmed: 0,
      reviewRequired: 1,
      errorCode: null,
    },
    memoryGlobalEnabled: true,
    now: new Date("2026-08-13T06:00:00.000Z"),
  });
  assert.equal(dashboard.plans.total, 2);
  assert.equal(dashboard.plans.active, 1);
  assert.equal(dashboard.memory.confirmed, 2);
  assert.equal(dashboard.memory.proposed, 2);
  assert.equal(dashboard.memory.conflictsPendingReview, 1);
  assert.equal(dashboard.memory.decisions, 1);
  assert.deepEqual(dashboard.recipes.map((recipe) => recipe.id), ["daily-report"]);
  assert.equal(dashboard.timeReturn.returnedHours, 1);
  assert.equal(dashboard.timeReturn.automationCoverage, 0.6667);
  assert.equal(dashboard.timeReturn.weeklyReturnedHours, 1);
  assert.equal(dashboard.timeReturn.weeklyAutomationCoverage, 0.6667);
  assert.deepEqual(dashboard.timeReturnSources, { workPlans: 0, shadowEvidence: 1 });
  assert.equal(dashboard.plans.items[0].id, "plan-2");
  assert.equal(dashboard.deliverables[0].reference, "a".repeat(64));
  assert.equal(dashboard.timeReturnCandidates[0].evidencePreviews[0].content, "# 已完成的交付草稿");
  assert.equal(dashboard.timeReturnCandidates[0].evidencePreviews[0].truncated, false);
  assert.equal(dashboard.memory.items[0].statement, "负责人已确认");
  assert.equal(dashboard.memory.reviewItems.length, 2);
  assert.equal(dashboard.memory.reviewItems.some((item) => item.id === "memory-other"), false);
  assert.equal(dashboard.memory.reviewItems.find((item) => item.id === "memory-2").conflicts[0].id, "memory-1");
  assert.equal(dashboard.memory.reviewItems.find((item) => item.id === "memory-3").conflicts.length, 0);
  assert.equal(dashboard.memory.reviewItems.find((item) => item.id === "memory-3").duplicates[0].id, "memory-4");
  assert.equal(dashboard.governedGraph.available, false);
  assert.equal(dashboard.memorySync.authorized, true);
  assert.equal(dashboard.memorySync.configured, true);
  assert.equal(dashboard.memorySync.expired, false);
  assert.equal(dashboard.memorySync.globalGateEnabled, true);
  assert.equal(dashboard.memorySync.autoConfirm, true);
  assert.equal(dashboard.memorySync.state, "review_required");
  assert.equal(dashboard.memorySync.sourceDigestPrefix, "aaaaaaaaaaaa");
  assert.deepEqual(dashboard.memorySync.sourcePaths, ["README.md", "docs/decisions.md"]);
});

test("项目驾驶舱把过期记忆授权显示为不可运行而不是继续授权", () => {
  const dashboard = buildProjectDashboard({
    manifest: {
      projectId: "project_1",
      name: "项目一",
      profile: { selectedRecipeIds: [], memoryScope: { retentionDays: 90 } },
      capabilities: {
        project_memory_proposal: {
          mode: "automatic",
          expiresAt: "2026-08-13T05:59:59.000Z",
          sourcePaths: ["README.md"],
          allowedFactKeyPrefixes: ["decision."],
          maxRetentionDays: 90,
          autoConfirm: true,
        },
      },
    },
    memoryGlobalEnabled: true,
    now: new Date("2026-08-13T06:00:00.000Z"),
  });
  assert.equal(dashboard.memorySync.configured, true);
  assert.equal(dashboard.memorySync.expired, true);
  assert.equal(dashboard.memorySync.authorized, false);
  assert.equal(dashboard.memorySync.globalGateEnabled, true);
});

test("项目驾驶舱只给待核销工作返回有界可审阅交付物正文", () => {
  const content = "x".repeat(5_000);
  const dashboard = buildProjectDashboard({
    manifest: {
      projectId: "project_1", name: "项目一",
      profile: { selectedRecipeIds: ["project-follow-up"] },
    },
    plans: [{
      id: "plan-1", project_id: "project_1", objective: "完成跟进", status: "completed",
      updated_at: "2026-08-13T01:00:00.000Z",
      plan: { recipe: { id: "project-follow-up", baselineMinutes: 45 } },
    }],
    planSteps: new Map([["plan-1", [
      { step_id: "research", capability: "research", status: "completed", evidence: { kind: "research_markdown", content, bytes: 5_000, sha256: "a".repeat(64), verification: "bounded" } },
      { step_id: "secret", capability: "local_test", status: "completed", evidence: { kind: "controlled_command", content: "不得展示", verification: "exit_zero" } },
    ]]]),
  });
  const previews = dashboard.timeReturnCandidates[0].evidencePreviews;
  assert.equal(previews.length, 1);
  assert.equal(previews[0].content.length, 4_000);
  assert.equal(previews[0].truncated, true);
  assert.doesNotMatch(JSON.stringify(previews), /不得展示/u);
});

test("项目驾驶舱限制待核销计划和每项正文预览数量", () => {
  const plans = Array.from({ length: 25 }, (_value, index) => ({
    id: `plan-${index}`, project_id: "project_1", objective: `完成跟进 ${index}`,
    status: "completed", updated_at: new Date(2026, 7, 13, 0, index).toISOString(),
    plan: { recipe: { id: "project-follow-up", baselineMinutes: 45 } },
  }));
  const steps = new Map(plans.map((plan) => [plan.id, Array.from(
    { length: 5 },
    (_value, index) => ({
      step_id: `draft-${index}`, capability: "document_draft", status: "completed",
      evidence: { kind: "document_markdown", content: `交付物 ${index}` },
    }),
  )]));
  const dashboard = buildProjectDashboard({
    manifest: { projectId: "project_1", name: "项目一", profile: {} },
    plans,
    planSteps: steps,
  });
  assert.equal(dashboard.timeReturnCandidates.length, 20);
  assert.ok(dashboard.timeReturnCandidates.every(
    (candidate) => candidate.evidencePreviews.length === 3,
  ));
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

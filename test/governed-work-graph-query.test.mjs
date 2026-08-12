import assert from "node:assert/strict";
import test from "node:test";
import {
  explainExecutionDrift,
  explainMemorySource,
  explainProjectChanges,
  explainStepAuthorization,
} from "../src/governed-work-graph-query.mjs";
import { createGraphEdge } from "../src/governed-work-graph.mjs";
import { graphFixture } from "./support/governed-work-graph-fixture.mjs";

test("四类图查询返回来源版本且不把路径冒充授权", () => {
  const fixture = graphFixture();
  const common = { ...fixture.scope, ...fixture.graph, now: fixture.observedAt };
  const authorization = explainStepAuthorization({ ...common, stepId: fixture.stepDomainId });
  assert.equal(authorization.status, "evidence_complete");
  assert.equal(authorization.authoritative, false);
  assert.equal(authorization.authorizationHash, fixture.authorizationHash);
  assert.equal(authorization.remainingBudget, "consult_capability_budget_ledger");
  const source = explainMemorySource({ ...common, memoryId: fixture.memoryId });
  assert.equal(source.status, "evidence_complete");
  assert.equal(source.source.provenance.recordVersion, "source-v1");
  const drift = explainExecutionDrift({ ...common, planId: fixture.planId });
  assert.equal(drift.status, "aligned");
  assert.deepEqual(drift.missingEvidence, []);
  const changes = explainProjectChanges({ ...common, planId: fixture.planId });
  assert.equal(changes.status, "evidence_complete");
  assert.equal(changes.timeReturns.length, 1);
});

test("图查询拒绝跨项目、无界输入、过期来源和缺失运行证据", () => {
  const fixture = graphFixture();
  const common = { ...fixture.scope, ...fixture.graph, now: fixture.observedAt };
  assert.throws(() => explainStepAuthorization({
    ...common, projectId: "other", stepId: fixture.stepDomainId,
  }), /crosses tenant or project/u);
  assert.throws(() => explainStepAuthorization({
    ...common, stepId: fixture.stepDomainId, maxDepth: 9,
  }), /maxDepth must be between/u);
  assert.throws(() => explainStepAuthorization({
    ...common, stepId: fixture.stepDomainId, maxResults: 1,
  }), /exceeds maxResults/u);
  const withoutRuntimeEvidence = {
    ...common,
    edges: common.edges.filter((edge) => edge.edgeType !== "step.produces_evidence"),
  };
  assert.equal(explainExecutionDrift({
    ...withoutRuntimeEvidence, planId: fixture.planId,
  }).status, "incomplete");
  assert.equal(explainMemorySource({
    ...common, memoryId: fixture.memoryId, now: "2027-01-01T00:00:00.000Z",
  }).reason, "memory_expired");
});

test("撤销关系不再出现在当前解释中且历史记录保持可验证", () => {
  const fixture = graphFixture({ invalidatePermission: true });
  const result = explainStepAuthorization({
    ...fixture.scope, ...fixture.graph, now: fixture.observedAt, stepId: fixture.stepDomainId,
  });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "intended_authorization_path_is_incomplete");
  assert.equal(fixture.graph.edges.some((edge) => edge.state === "invalidated"), true);
});

test("重复采集形成历史观察但当前解释按 relationKey 只取最新状态", () => {
  const fixture = graphFixture();
  const repeated = fixture.graph.edges.map((edge) => ({
    ...edge,
    observedAt: "2026-08-12T08:01:00.000Z",
    validFrom: edge.validFrom,
  }));
  const observations = repeated.map((edge) => createGraphEdge(edge));
  const result = explainStepAuthorization({
    ...fixture.scope,
    nodes: fixture.graph.nodes,
    edges: [...fixture.graph.edges, ...observations],
    now: "2026-08-12T08:01:00.000Z",
    stepId: fixture.stepDomainId,
  });
  assert.equal(result.status, "evidence_complete");
  assert.equal(result.edges.length, 5);
});

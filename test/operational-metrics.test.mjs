import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationalMetrics } from "../src/operational-metrics.mjs";

test("运营指标按固定窗口计算 P95、成功率、审批等待和审计覆盖", () => {
  const report = buildOperationalMetrics({
    messages: [
      { occurredAt: "2026-08-05T00:00:00Z", ingestedAt: "2026-08-05T00:00:01Z" },
      { occurredAt: "2026-08-05T00:01:00Z", ingestedAt: "2026-08-05T00:01:06Z" },
    ],
    tasks: [
      {
        status: "completed",
        result: { riskLevel: "low" },
        created_at: "2026-08-05T00:00:00Z",
        updated_at: "2026-08-05T00:01:00Z",
        draft_ready_at: "2026-08-05T00:00:10Z",
        decision_at: "2026-08-05T00:00:40Z",
      },
      {
        status: "dead",
        result: { riskLevel: "low" },
        created_at: "2026-08-05T00:00:00Z",
        updated_at: "2026-08-05T00:03:00Z",
        last_error: "request_timeout",
      },
    ],
    sideEffects: [
      { taskId: "1", capability: "send_message", status: "completed", receiptPresent: true },
      { taskId: "2", capability: "send_message", status: "unknown", receiptPresent: false },
    ],
    messageCoverage: {
      checkedAt: "2026-08-05T23:59:00Z",
      windowStart: "2026-08-04T23:57:00Z",
      windowEnd: "2026-08-05T23:57:00Z",
      dataComplete: true,
      sourceMessages: 1000,
      missedBeforeRepair: 1,
      repairedMessages: 1,
      remainingMissing: 0,
    },
  }, {
    since: new Date("2026-08-05T00:00:00Z"),
    now: new Date("2026-08-06T00:00:00Z"),
  });
  assert.equal(report.messageDetection.p95Ms, 6_000);
  assert.equal(report.messageDetection.targetMet, false);
  assert.equal(report.messageCoverage.observedMissRate, 0.001);
  assert.equal(report.messageCoverage.targetMet, false);
  assert.equal(report.messageCoverage.finalMissRate, 0);
  assert.equal(report.lowRiskTasks.successRate, 0.5);
  assert.equal(report.lowRiskTasks.durationSamples, 1);
  assert.equal(report.lowRiskTasks.durationP95Ms, 10_000);
  assert.equal(report.lowRiskTasks.lifecycleSamples, 2);
  assert.equal(report.lowRiskTasks.lifecycleP95Ms, 180_000);
  assert.equal(report.approvalWait.p95Ms, 30_000);
  assert.equal(report.reliability.sideEffectAuditCoverage, 1);
  assert.equal(report.reliability.codexTimeouts, 1);
});

test("没有样本时明确返回未知而不是假装达到 SLO", () => {
  const report = buildOperationalMetrics({}, {
    since: new Date("2026-08-05T00:00:00Z"),
    now: new Date("2026-08-06T00:00:00Z"),
  });
  assert.equal(report.messageDetection.targetMet, null);
  assert.equal(report.messageCoverage, null);
  assert.equal(report.lowRiskTasks.successRateTargetMet, null);
  assert.equal(report.lowRiskTasks.durationP95Ms, null);
  assert.equal(report.lowRiskTasks.lifecycleP95Ms, null);
  assert.equal(report.reliability.sideEffectAuditCoverage, null);
});

test("接续路由不提前计作端到端成功", () => {
  const report = buildOperationalMetrics({
    tasks: [{
      status: "continued",
      result: { riskLevel: "low" },
      created_at: "2026-08-05T00:00:00Z",
      updated_at: "2026-08-05T00:00:10Z",
      draft_ready_at: "2026-08-05T00:00:08Z",
    }],
  }, {
    since: new Date("2026-08-05T00:00:00Z"),
    now: new Date("2026-08-06T00:00:00Z"),
  });

  assert.equal(report.lowRiskTasks.samples, 0);
  assert.equal(report.lowRiskTasks.successes, 0);
  assert.equal(report.lowRiskTasks.successRate, null);
  assert.deepEqual(report.continuationRouting, {
    routed: 1,
    terminalChildren: 0,
    successfulChildren: 0,
    terminalSuccessRate: null,
  });
});

test("接续子任务到达终态后才结算成功且不双计父任务", () => {
  const report = buildOperationalMetrics({
    tasks: [
      {
        id: "parent",
        status: "continued",
        result: { riskLevel: "low" },
        created_at: "2026-08-05T00:00:00Z",
        updated_at: "2026-08-05T00:00:10Z",
        draft_ready_at: "2026-08-05T00:00:08Z",
      },
      {
        id: "child",
        continuation_of_task_id: "parent",
        status: "completed",
        result: { riskLevel: "low" },
        created_at: "2026-08-05T00:00:10Z",
        updated_at: "2026-08-05T00:00:30Z",
        draft_ready_at: "2026-08-05T00:00:18Z",
      },
    ],
  }, {
    since: new Date("2026-08-05T00:00:00Z"),
    now: new Date("2026-08-06T00:00:00Z"),
  });

  assert.equal(report.lowRiskTasks.samples, 1);
  assert.equal(report.lowRiskTasks.successes, 1);
  assert.equal(report.lowRiskTasks.successRate, 1);
  assert.deepEqual(report.continuationRouting, {
    routed: 1,
    terminalChildren: 1,
    successfulChildren: 1,
    terminalSuccessRate: 1,
  });
});

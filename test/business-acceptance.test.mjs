import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBusinessAcceptance } from "../src/business-acceptance.mjs";

function passingInput() {
  return {
    health: {
      ready: true,
      checks: {
        operationalMetrics: {
          window: { dataComplete: true },
          availability: { targetMet: true },
          messageDetection: { targetMet: true },
          messageCoverage: { targetMet: true, remainingMissing: 0 },
          lowRiskTasks: {
            successRateTargetMet: true,
            durationTargetMet: true,
          },
          reliability: {
            duplicateSideEffects: 0,
            unknownSideEffects: 0,
            completedSideEffects: 1,
            sideEffectAuditCoverage: 1,
          },
          memoryConflicts: { activeConflictGroups: 0 },
        },
      },
    },
    quality: { accepted: true },
  };
}

test("业务放量只有健康、质量和全部长期指标同时通过才接受", () => {
  const result = evaluateBusinessAcceptance(passingInput());
  assert.equal(result.accepted, true);
  assert.deepEqual(result.blockers, []);
  assert.ok(Object.values(result.gates).every(Boolean));
});

test("缺少样本或未完成三十天窗口时失败关闭", () => {
  const input = passingInput();
  input.health.checks.operationalMetrics.availability.targetMet = null;
  input.health.checks.operationalMetrics.messageDetection.targetMet = null;
  input.health.checks.operationalMetrics.lowRiskTasks.durationTargetMet = null;
  const result = evaluateBusinessAcceptance(input);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.blockers, [
    "availability",
    "messageDetection",
    "lowRiskDuration",
  ]);
});

test("重复副作用、未知结果、漏检和记忆冲突独立阻止放量", () => {
  const input = passingInput();
  const operational = input.health.checks.operationalMetrics;
  operational.messageCoverage.remainingMissing = 1;
  operational.reliability.duplicateSideEffects = 1;
  operational.reliability.unknownSideEffects = 1;
  operational.reliability.sideEffectAuditCoverage = 0.5;
  operational.memoryConflicts.activeConflictGroups = 1;
  const result = evaluateBusinessAcceptance(input);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.blockers, [
    "messageCoverage",
    "duplicateSideEffects",
    "unknownSideEffects",
    "sideEffectAudit",
    "memoryConflicts",
  ]);
});

test("没有外部副作用时审计覆盖率未知不阻止影子验收", () => {
  const input = passingInput();
  input.health.checks.operationalMetrics.reliability.completedSideEffects = 0;
  input.health.checks.operationalMetrics.reliability.sideEffectAuditCoverage = null;
  assert.equal(evaluateBusinessAcceptance(input).accepted, true);
});

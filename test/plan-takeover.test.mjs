import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanTakeover } from "../src/plan-takeover.mjs";

function plan(overrides = {}) {
  return {
    id: "plan_1",
    status: "executing",
    cancel_requested_at: null,
    lease_expires_at: "2026-08-05T10:05:00.000Z",
    plan: {
      steps: [{
        id: "step_1",
        capability: "production_deploy",
        description: "部署",
      }],
    },
    ...overrides,
  };
}

test("不可中断外部动作收到取消后显示安全收尾而不是假装已停止", () => {
  const report = buildPlanTakeover(
    plan({ cancel_requested_at: "2026-08-05T10:00:01.000Z" }),
    [{ step_id: "step_1", status: "executing" }],
    { now: new Date("2026-08-05T10:00:02.000Z") },
  );
  assert.equal(report.state, "safe_finishing");
  assert.equal(report.currentStep.sideEffect, true);
  assert.equal(report.currentStep.interruptible, false);
  assert.equal(report.canRequestCancellation, false);
});

test("可中断步骤必须有执行证据才能显示已确认中断", () => {
  const awaiting = buildPlanTakeover(
    plan({
      cancel_requested_at: "2026-08-05T10:00:01.000Z",
      plan: { steps: [{ id: "step_1", capability: "local_test", description: "测试" }] },
    }),
    [{ step_id: "step_1", status: "executing" }],
    { now: new Date("2026-08-05T10:00:02.000Z") },
  );
  assert.equal(awaiting.state, "interrupt_requested");

  const confirmed = buildPlanTakeover(
    plan({
      status: "cancelled",
      cancel_requested_at: "2026-08-05T10:00:01.000Z",
      plan: { steps: [{ id: "step_1", capability: "local_test", description: "测试" }] },
    }),
    [{
      step_id: "step_1",
      status: "cancelled",
      error: "operator_interrupted",
      evidence: { verification: "operator_interrupt_confirmed", kind: "controlled_command" },
    }],
    { now: new Date("2026-08-05T10:00:02.000Z") },
  );
  assert.equal(confirmed.state, "interrupt_confirmed");
  assert.equal(confirmed.terminal, true);
});

test("过期执行租约要求先核对而不是直接重试", () => {
  const report = buildPlanTakeover(
    plan({ lease_expires_at: "2026-08-05T09:59:00.000Z" }),
    [{ step_id: "step_1", status: "executing" }],
    { now: new Date("2026-08-05T10:00:00.000Z") },
  );
  assert.equal(report.state, "lease_expired");
  assert.match(report.handoffAction, /禁止直接重试/u);
});

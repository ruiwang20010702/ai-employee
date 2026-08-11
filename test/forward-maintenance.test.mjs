import assert from "node:assert/strict";
import test from "node:test";
import {
  assertForwardMaintenanceState,
  evaluateForwardMaintenanceState,
} from "../src/forward-maintenance.mjs";

test("维护前滚只允许暂停且没有任何活动任务计划或待入库消息", () => {
  assert.deepEqual(
    evaluateForwardMaintenanceState({
      paused: true,
      tasks: { dead: 2, completed: 3 },
      workPlans: { completed: 1 },
      pendingMessages: 0,
      expiredExecutionLeases: 0,
    }),
    {
      safe: true,
      blockers: [],
      paused: true,
      activeTasks: 0,
      activePlans: 0,
      pendingMessages: 0,
      expiredExecutionLeases: 0,
      tasks: { dead: 2, completed: 3 },
      workPlans: { completed: 1 },
    },
  );
});

test("维护前滚对暂停、发送未知、执行中计划和待处理消息全部失败关闭", () => {
  const state = {
    paused: false,
    tasks: { send_unknown: 1 },
    workPlans: { executing: 1 },
    pendingMessages: 1,
    expiredExecutionLeases: 1,
  };
  assert.deepEqual(evaluateForwardMaintenanceState(state).blockers, [
    "system_not_paused",
    "active_tasks",
    "active_work_plans",
    "pending_messages",
    "expired_execution_leases",
  ]);
  assert.throws(
    () => assertForwardMaintenanceState(state),
    (error) =>
      error.code === "forward_maintenance_state_unsafe" &&
      error.evidence.safe === false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanResultDraft, planResultTaskId } from "../src/plan-result-notification.mjs";

test("计划结果草稿只包含可审核摘要并使用确定性任务编号", () => {
  const plan = {
    id: "plan_1",
    status: "failed",
    max_level: "L4",
    plan: { sourceTaskId: "task_1" },
  };
  const draft = buildPlanResultDraft({
    plan,
    steps: [
      { capability: "code_patch", status: "completed" },
      { capability: "production_deploy", status: "failed" },
    ],
    now: new Date("2026-08-04T10:00:00.000Z"),
  });
  assert.equal(draft.id, planResultTaskId(plan.id));
  assert.equal(draft.result.riskLevel, "high");
  assert.match(draft.result.reply, /production_deploy/u);
  assert.match(draft.result.reply, /确认后可以发送/u);
});

test("没有来源任务或计划未终止时不生成回传", () => {
  assert.equal(buildPlanResultDraft({ plan: { status: "completed", plan: {} }, steps: [] }), null);
  assert.equal(buildPlanResultDraft({ plan: { status: "executing", plan: { sourceTaskId: "task" } }, steps: [] }), null);
});

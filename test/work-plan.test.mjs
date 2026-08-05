import assert from "node:assert/strict";
import test from "node:test";
import {
  assessWorkPlan,
  validateWorkPlan,
  validateWorkPlanRevision,
} from "../src/work-plan.mjs";

const manifest = {
  version: 1,
  projectId: "test_project",
  name: "测试项目",
  rootDirectory: "/workspace/project",
  requesters: ["user-1"],
  capabilities: {
    document_draft: { mode: "automatic" },
    code_patch: { mode: "approval_required" },
    local_test: {
      mode: "automatic",
      commands: { 检查: { executable: "/usr/bin/true", args: [] } },
    },
    production_deploy: {
      mode: "approval_required",
      commands: { 发布: { executable: "/usr/bin/true", args: [] } },
    },
  },
};

function plan() {
  return {
    version: 1,
    projectId: "test_project",
    requesterId: "user-1",
    objective: "完成修改并准备上线",
    steps: [
      {
        id: "code",
        capability: "code_patch",
        description: "修改代码",
        workingDirectory: "/workspace/project/app",
        expectedEvidence: "代码差异",
      },
      {
        id: "test",
        capability: "local_test",
        description: "运行测试",
        workingDirectory: "/workspace/project",
        expectedEvidence: "测试输出",
        rollback: "清理测试数据",
        inputs: { commandId: "检查" },
      },
    ],
  };
}

test("任务计划绑定项目、能力、证据和回滚", () => {
  const result = assessWorkPlan({ plan: plan(), manifest });
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.maxLevel, "L2");
  assert.match(result.planHash, /^[a-f0-9]{64}$/u);
});

test("计划内容变化会让审批哈希失效", () => {
  const first = assessWorkPlan({ plan: plan(), manifest });
  const changed = plan();
  changed.steps[0].description = "修改更多代码";
  const second = assessWorkPlan({ plan: changed, manifest });
  assert.notEqual(first.planHash, second.planHash);
});

test("计划修订必须保留来源身份且真正改变内容", () => {
  const current = assessWorkPlan({ plan: plan(), manifest });
  const changed = plan();
  changed.objective = "完成修订后的修改并准备上线";
  const revised = assessWorkPlan({ plan: changed, manifest });
  assert.doesNotThrow(() => validateWorkPlanRevision({
    currentPlan: current.plan,
    currentPlanHash: current.planHash,
    assessment: revised,
  }));
  assert.throws(
    () => validateWorkPlanRevision({
      currentPlan: current.plan,
      currentPlanHash: current.planHash,
      assessment: current,
    }),
    /must change/u,
  );
  const differentRequester = plan();
  differentRequester.requesterId = "user-2";
  const forged = {
    ...revised,
    plan: validateWorkPlan(differentRequester),
  };
  assert.throws(
    () => validateWorkPlanRevision({
      currentPlan: current.plan,
      currentPlanHash: current.planHash,
      assessment: forged,
    }),
    /cannot change requesterId/u,
  );
});

test("有副作用的步骤缺少回滚说明时拒绝成型", () => {
  const invalid = plan();
  delete invalid.steps[1].rollback;
  assert.throws(() => validateWorkPlan(invalid), /requires rollback/u);
});

test("项目命令定义变化会让计划审批哈希失效", () => {
  const first = structuredClone(manifest);
  const second = structuredClone(first);
  second.capabilities.local_test.commands.检查.executable = "/usr/bin/false";
  assert.notEqual(
    assessWorkPlan({ plan: plan(), manifest: first }).planHash,
    assessWorkPlan({ plan: plan(), manifest: second }).planHash,
  );
});

test("任务计划限制步骤数量、文本长度与输入深度", () => {
  const tooMany = plan();
  tooMany.steps = Array.from({ length: 31 }, (_, index) => ({
    ...tooMany.steps[0], id: `step_${index}`,
  }));
  assert.throws(() => validateWorkPlan(tooMany), /cannot exceed 30 steps/u);

  const tooLong = plan();
  tooLong.objective = "长".repeat(4_001);
  assert.throws(() => validateWorkPlan(tooLong), /exceeds 4000/u);

  const tooDeep = plan();
  let cursor = {};
  tooDeep.steps[0].inputs = cursor;
  for (let index = 0; index < 11; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.throws(() => validateWorkPlan(tooDeep), /nesting depth/u);

  const tooLarge = plan();
  tooLarge.steps[0].inputs = { value: "大".repeat(30_000) };
  assert.throws(() => validateWorkPlan(tooLarge), /exceeds 65536 bytes/u);
});

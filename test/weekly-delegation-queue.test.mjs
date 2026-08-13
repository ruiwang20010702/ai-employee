import assert from "node:assert/strict";
import test from "node:test";
import { buildWeeklyDelegationQueue } from "../src/weekly-delegation-queue.mjs";

const recipe = (id, baselineMinutes, capabilities) => ({
  id,
  name: id,
  baselineMinutes,
  baselineMethod: "user_confirmed",
  inputs: [{ name: "focus", type: "string", required: true, description: "工作重点" }],
  steps: capabilities.map((capability) => ({ capability })),
});

test("本周返还队列只用已确认证据估算，未验证配方不冒充节省时间", () => {
  const result = buildWeeklyDelegationQueue({
    manifests: [{
      projectId: "project_a",
      name: "项目 A",
      profile: {
        selectedRecipeIds: [
          "daily-report", "project-follow-up", "code-delivery", "calendar-follow-up",
        ],
      },
      capabilities: {
        research: { mode: "automatic" },
        document_draft: { mode: "automatic" },
        code_patch: { mode: "disabled" },
        calendar_event: { mode: "unknown" },
      },
    }],
    recipes: [
      recipe("daily-report", 30, ["document_draft"]),
      recipe("project-follow-up", 45, ["research", "document_draft"]),
      recipe("code-delivery", 120, ["code_patch"]),
      recipe("calendar-follow-up", 45, ["calendar_event"]),
    ],
    plans: [],
    timeReturns: [
      {
        projectId: "project_a", workPlanId: "done-this-week", recipeId: "daily-report",
        baselineMinutes: 30, humanActiveMinutes: 10, returnedMinutes: 20,
        status: "confirmed", confirmedAt: "2026-08-12T02:00:00.000Z",
      },
      {
        projectId: "project_a", workPlanId: "done-last-week", recipeId: "daily-report",
        baselineMinutes: 30, humanActiveMinutes: 5, returnedMinutes: 25,
        status: "confirmed", confirmedAt: "2026-08-05T02:00:00.000Z",
      },
    ],
    now: new Date("2026-08-13T06:00:00.000Z"),
    executionEnabled: false,
  });

  assert.equal(result.weeklyTargetMinutes, 480);
  assert.equal(result.weeklyReturnedMinutes, 20);
  assert.equal(result.remainingMinutes, 460);
  assert.equal(result.items[0].recipeId, "daily-report");
  assert.equal(result.items[0].evidenceStatus, "verified_history");
  assert.equal(result.items[0].conservativeReturnedMinutes, 20);
  assert.equal(result.items[0].evidenceSamples, 2);
  assert.equal(result.items[1].recipeId, "project-follow-up");
  assert.equal(result.items[1].evidenceStatus, "needs_validation");
  assert.equal(result.items[1].conservativeReturnedMinutes, null);
  assert.equal(result.projectedVerifiedReturnedMinutes, 20);
  assert.equal(result.remainingAfterVerifiedQueueMinutes, 440);
  assert.equal(result.blocked.length, 2);
  assert.equal(result.blocked[0].recipeId, "code-delivery");
  assert.deepEqual(result.blocked[0].disabledCapabilities, ["code_patch"]);
  assert.equal(result.blocked[1].recipeId, "calendar-follow-up");
  assert.deepEqual(result.blocked[1].disabledCapabilities, ["calendar_event"]);
  assert.equal(result.executionEnabled, false);
  assert.equal(
    result.items.every((item) => item.executionPath === "global_execution_disabled"),
    true,
  );
});

test("已有活动计划不会被重复推荐，达到周目标后队列为空", () => {
  const manifest = {
    projectId: "project_a",
    name: "项目 A",
    profile: { selectedRecipeIds: ["daily-report"] },
    capabilities: { document_draft: { mode: "approval_required" } },
  };
  const daily = recipe("daily-report", 480, ["document_draft"]);
  const completedWeek = {
    projectId: "project_a", workPlanId: "done", recipeId: "daily-report",
    baselineMinutes: 480, humanActiveMinutes: 0, returnedMinutes: 480,
    status: "confirmed", confirmedAt: "2026-08-12T02:00:00.000Z",
  };
  const achieved = buildWeeklyDelegationQueue({
    manifests: [manifest], recipes: [daily], plans: [], timeReturns: [completedWeek],
    now: new Date("2026-08-13T06:00:00.000Z"), executionEnabled: true,
  });
  assert.equal(achieved.targetMet, true);
  assert.deepEqual(achieved.items, []);

  const active = buildWeeklyDelegationQueue({
    manifests: [manifest], recipes: [daily], timeReturns: [],
    plans: [{
      id: "active", project_id: "project_a", status: "executing",
      plan: { recipe: { id: "daily-report" } },
    }],
    now: new Date("2026-08-13T06:00:00.000Z"), executionEnabled: true,
  });
  assert.equal(active.items.length, 0);
  assert.equal(active.inProgress.length, 1);
  assert.equal(active.inProgress[0].workPlanId, "active");
});

test("执行能力打开也只说明实例化后的受控路径，不宣称当前可执行", () => {
  const result = buildWeeklyDelegationQueue({
    manifests: [{
      projectId: "project_a",
      name: "项目 A",
      profile: { selectedRecipeIds: ["daily-report", "project-follow-up"] },
      capabilities: {
        document_draft: { mode: "approval_required" },
        research: { mode: "automatic" },
      },
    }],
    recipes: [
      recipe("daily-report", 30, ["document_draft"]),
      recipe("project-follow-up", 45, ["research"]),
    ],
    executionEnabled: true,
    now: new Date("2026-08-13T06:00:00.000Z"),
  });

  assert.equal(
    result.items.find((item) => item.recipeId === "daily-report").executionPath,
    "approval_required_after_instantiation",
  );
  assert.equal(
    result.items.find((item) => item.recipeId === "project-follow-up").executionPath,
    "project_policy_after_instantiation",
  );
  assert.equal(result.items.some((item) => Object.hasOwn(item, "canExecuteNow")), false);
});

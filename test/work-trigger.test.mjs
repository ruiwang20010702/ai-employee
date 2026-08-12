import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildTriggeredWorkPlan,
  nextScheduledRun,
  validateWorkEvent,
  validateWorkTrigger,
  workTriggerMatchesEvent,
} from "../src/work-trigger.mjs";

const manifest = {
  version: 1,
  projectId: "project_1",
  name: "项目",
  rootDirectory: "/workspace/project",
  requesters: ["owner"],
  profile: {
    objective: "返还时间",
    successCriteria: [],
    milestones: [],
    collaborationObjects: [],
    selectedRecipeIds: ["project-follow-up"],
    memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
  },
  capabilities: {
    research: { mode: "automatic" },
    document_draft: { mode: "automatic" },
  },
};

const recipe = JSON.parse(await readFile(
  new URL("../deploy/recipes/project-follow-up.json", import.meta.url),
  "utf8",
));

test("时间触发器以运行时间形成不同计划并仍经过项目策略", () => {
  const trigger = validateWorkTrigger({
    version: 1,
    id: "weekly-follow-up",
    projectId: "project_1",
    recipeId: "project-follow-up",
    requesterId: "owner",
    kind: "schedule",
    enabled: true,
    values: { projectFocus: "本周关键进度" },
    schedule: { startsAt: "2026-08-12T01:00:00.000Z", intervalMinutes: 10_080 },
  });
  assert.equal(
    nextScheduledRun(trigger, new Date("2026-08-12T01:00:00.000Z")).toISOString(),
    "2026-08-19T01:00:00.000Z",
  );
  const first = buildTriggeredWorkPlan({
    trigger, recipe, manifest, scheduledFor: "2026-08-12T01:00:00.000Z",
  });
  const second = buildTriggeredWorkPlan({
    trigger, recipe, manifest, scheduledFor: "2026-08-19T01:00:00.000Z",
  });
  assert.equal(first.assessment.decision, "ALLOW");
  assert.notEqual(first.assessment.planHash, second.assessment.planHash);
  assert.equal(first.assessment.plan.recipe.triggerId, trigger.id);
});

test("事件触发器只接受精确类型和过滤条件并绑定事件字段", () => {
  const trigger = validateWorkTrigger({
    version: 1,
    id: "github-issue-follow-up",
    projectId: "project_1",
    recipeId: "project-follow-up",
    requesterId: "owner",
    kind: "event",
    enabled: true,
    event: { type: "github.issue.opened", filters: { repository: "owner/repo" } },
    valueBindings: { projectFocus: "payload.title" },
  });
  const event = validateWorkEvent({
    id: "delivery-42",
    type: "github.issue.opened",
    source: "github",
    occurredAt: "2026-08-12T02:00:00.000Z",
    payload: { title: "修复登录问题", repository: "owner/repo" },
  });
  assert.equal(workTriggerMatchesEvent(trigger, event), true);
  const result = buildTriggeredWorkPlan({ trigger, event, recipe, manifest });
  assert.match(result.assessment.plan.objective, /修复登录问题/u);
  assert.equal(result.assessment.decision, "ALLOW");
  assert.equal(workTriggerMatchesEvent(trigger, { ...event, payload: { ...event.payload, repository: "other/repo" } }), false);
});

test("触发器默认关闭并拒绝秘密式任意路径绑定", () => {
  const disabled = validateWorkTrigger({
    version: 1,
    id: "safe-trigger",
    projectId: "project_1",
    recipeId: "project-follow-up",
    requesterId: "owner",
    kind: "event",
    event: { type: "meeting.ended" },
  });
  assert.equal(disabled.enabled, false);
  assert.throws(
    () => validateWorkTrigger({
      ...disabled,
      valueBindings: { projectFocus: "constructor.prototype.secret" },
    }),
    /bounded event payload path/u,
  );
  assert.throws(
    () => buildTriggeredWorkPlan({
      trigger: disabled,
      recipe,
      manifest,
      event: { id: "e1", type: "meeting.ended", source: "meeting", occurredAt: "2026-08-12T02:00:00.000Z" },
    }),
    /Disabled trigger/u,
  );
  assert.throws(
    () => validateWorkTrigger({
      ...disabled,
      values: { oversized: "x".repeat(64 * 1024) },
    }),
    /exceeds 64 KiB/u,
  );
  assert.throws(
    () => validateWorkTrigger({
      ...disabled,
      values: { password: "correct-horse-battery-staple" },
    }),
    /cannot persist credential material/u,
  );
  assert.throws(
    () => validateWorkTrigger({
      ...disabled,
      event: { type: "meeting.ended", filters: { "prototype.value": "expected" } },
    }),
    /bounded payload path/u,
  );
});

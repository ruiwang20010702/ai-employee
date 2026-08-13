import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWorkRecipes } from "../src/recipe-library.mjs";
import { ingestProactiveEvent, runDueProactiveTrigger } from "../src/proactive-runtime.mjs";
import { Store } from "../src/store.mjs";
import { buildTriggeredWorkPlan } from "../src/work-trigger.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "foursday-proactive-"));
  const store = await new Store(join(directory, "runtime.sqlite")).open();
  t.after(async () => { store.close();await rm(directory, { recursive: true, force: true }); });
  return store;
}

const manifest = {
  version: 1,
  projectId: "project_1",
  name: "项目",
  rootDirectory: "/workspace/project",
  requesters: ["owner"],
  profile: {
    objective: "主动推进",
    successCriteria: [], milestones: [], collaborationObjects: [],
    selectedRecipeIds: ["project-follow-up"],
    memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
  },
  capabilities: { research: { mode: "automatic" }, document_draft: { mode: "automatic" } },
};

test("主动工作按时间生成受控计划且同一运行不会重复", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T01:00:00.000Z");
  store.createWorkTrigger({
    version: 1,
    id: "weekly-follow-up",
    projectId: manifest.projectId,
    recipeId: "project-follow-up",
    requesterId: "owner",
    kind: "schedule",
    enabled: true,
    maxRunsPerDay: 2,
    values: { projectFocus: "本周关键进度" },
    schedule: { startsAt: now.toISOString(), intervalMinutes: 10_080 },
  }, "owner", now);
  const result = await runDueProactiveTrigger({
    store,
    manifests: new Map([[manifest.projectId, manifest]]),
    recipes: await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)),
    owner: "proactive-test",
    now,
  });
  assert.equal(result.created, true);
  assert.equal(result.plan.plan.recipe.triggerId, "weekly-follow-up");
  assert.equal(result.plan.status, "ready");
  assert.equal(store.listWorkPlans({ limit: 10 }).length, 1);
  assert.equal(await runDueProactiveTrigger({
    store,
    manifests: new Map([[manifest.projectId, manifest]]),
    recipes: await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)),
    owner: "proactive-test",
    now,
  }), null);
});

test("主动项目记忆更新只生成证据绑定的待审批计划", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T01:30:00.000Z");
  const memoryManifest = structuredClone(manifest);
  memoryManifest.profile.selectedRecipeIds = ["project-memory-update"];
  memoryManifest.profile.memoryScope = { allowedTypes: ["project"], retentionDays: 90 };
  memoryManifest.capabilities.project_memory_proposal = {
    mode: "approval_required",
    allowedFactKeyPrefixes: ["risk."],
    maxRetentionDays: 90,
    maxRuns: 1,
  };
  store.createWorkTrigger({
    version: 1,
    id: "weekly-memory-review",
    projectId: memoryManifest.projectId,
    recipeId: "project-memory-update",
    requesterId: "owner",
    kind: "schedule",
    enabled: true,
    maxRunsPerDay: 1,
    values: {
      projectFocus: "核对供应商交付风险",
      memoryStatement: "供应商交付存在一周延期风险。",
      memoryFactKey: "risk.delivery_delay",
      memoryRetentionDays: 90,
    },
    schedule: { startsAt: now.toISOString(), intervalMinutes: 10_080 },
  }, "owner", now);
  const result = await runDueProactiveTrigger({
    store,
    manifests: new Map([[memoryManifest.projectId, memoryManifest]]),
    recipes: await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)),
    owner: "proactive-test",
    now,
  });
  assert.equal(result.created, true);
  assert.equal(result.plan.status, "awaiting_approval");
  assert.equal(result.plan.plan.steps.at(-1).capability, "project_memory_proposal");
  assert.equal(result.plan.plan.steps.at(-1).inputs.documentStepId, "draft-memory-review");
});

test("事件主动工作按事件编号幂等并受每日次数与冷却约束", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T02:00:00.000Z");
  store.createWorkTrigger({
    version: 1,
    id: "github-issue-follow-up",
    projectId: manifest.projectId,
    recipeId: "project-follow-up",
    requesterId: "owner",
    kind: "event",
    enabled: true,
    maxRunsPerDay: 1,
    cooldownMinutes: 60,
    event: { type: "github.issue.opened", filters: { repository: "owner/repo" } },
    valueBindings: { projectFocus: "payload.title" },
  }, "owner", now);
  const context = {
    store,
    manifests: new Map([[manifest.projectId, manifest]]),
    recipes: await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)),
    owner: "github-adapter",
    now,
  };
  const event = {
    id: "delivery-42", type: "github.issue.opened", source: "github",
    occurredAt: now.toISOString(), payload: { repository: "owner/repo", title: "修复登录" },
  };
  assert.equal((await ingestProactiveEvent({ ...context, event }))[0].created, true);
  assert.equal((await ingestProactiveEvent({ ...context, event }))[0].created, false);
  const another = { ...event, id: "delivery-43", payload: { ...event.payload, title: "修复注册" } };
  assert.equal((await ingestProactiveEvent({ ...context, event: another }))[0].created, false);
  assert.equal(store.listWorkPlans({ limit: 10 }).length, 1);
});

test("禁用触发器不产生工作，启用需要显式操作", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T03:00:00.000Z");
  const created = store.createWorkTrigger({
    version: 1, id: "disabled-trigger", projectId: manifest.projectId,
    recipeId: "project-follow-up", requesterId: "owner", kind: "event",
    event: { type: "meeting.ended" }, values: { projectFocus: "会议跟进" },
  }, "owner", now);
  assert.equal(created.status, "disabled");
  const results = await ingestProactiveEvent({
    store,
    manifests: new Map([[manifest.projectId, manifest]]),
    recipes: await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)),
    owner: "meeting-adapter",
    now,
    event: { id: "meeting-1", type: "meeting.ended", source: "meeting", occurredAt: now.toISOString(), payload: {} },
  });
  assert.deepEqual(results, []);
  assert.equal(store.setWorkTriggerEnabled(created.id, true, "owner", now).status, "enabled");
});

test("触发运行只能由预留它的实例完成", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T04:00:00.000Z");
  store.createWorkTrigger({
    version: 1, id: "leased-trigger", projectId: manifest.projectId,
    recipeId: "project-follow-up", requesterId: "owner", kind: "event",
    enabled: true, event: { type: "meeting.ended" }, values: { projectFocus: "会议跟进" },
  }, "owner", now);
  const runKey = "a".repeat(64);
  assert.equal(store.reserveWorkTriggerRun("leased-trigger", runKey, "worker-a", now), true);
  assert.throws(
    () => store.completeWorkTriggerRun("leased-trigger", runKey, "plan-1", "worker-b", now),
    /not claimed/u,
  );
  assert.equal(store.failWorkTriggerRun("leased-trigger", runKey, "test", "worker-a", now), "failed");
});

test("主动计划只有在触发运行完成落账后才能消费授权", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T04:15:00.000Z");
  const trigger = store.createWorkTrigger({
    version: 1, id: "atomic-trigger", projectId: manifest.projectId,
    recipeId: "project-follow-up", requesterId: "owner", kind: "event",
    enabled: true, event: { type: "meeting.ended" }, values: { projectFocus: "原子落账" },
  }, "owner", now);
  const recipes = await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url));
  const built = buildTriggeredWorkPlan({
    trigger,
    recipe: recipes.get(trigger.recipeId),
    manifest,
    event: { id: "atomic-event", type: "meeting.ended", source: "meeting", occurredAt: now.toISOString(), payload: {} },
  });
  assert.equal(store.reserveWorkTriggerRun(trigger.id, built.runKey, "worker-a", now), true);
  const plan = store.registerWorkPlan(built.assessment, now);
  assert.throws(
    () => store.consumeWorkPlanAuthorization(plan.id, now),
    /triggered work plan run is not completed/ui,
  );
  store.completeWorkTriggerRun(trigger.id, built.runKey, plan.id, "worker-a", now);
  assert.equal(store.consumeWorkPlanAuthorization(plan.id, now), true);
});

test("时间触发运行必须由租约实例预留且失败后推进下次时间", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T04:30:00.000Z");
  store.createWorkTrigger({
    version: 1, id: "schedule-lease", projectId: manifest.projectId,
    recipeId: "project-follow-up", requesterId: "owner", kind: "schedule",
    enabled: true, schedule: { startsAt: now.toISOString(), intervalMinutes: 60 },
    values: { projectFocus: "租约核对" },
  }, "owner", now);
  const claimed = store.claimDueWorkTrigger(
    "worker-a",
    new Date(now.getTime() + 60_000),
    now,
  );
  assert.equal(claimed.leaseOwner, "worker-a");
  const runKey = "b".repeat(64);
  assert.equal(store.reserveWorkTriggerRun(claimed.id, runKey, "worker-b", now), false);
  assert.equal(store.reserveWorkTriggerRun(claimed.id, runKey, "worker-a", now), true);
  assert.equal(store.failWorkTriggerRun(claimed.id, runKey, "test", "worker-a", now), "failed");
  const failed = store.getWorkTrigger(claimed.id);
  assert.equal(failed.leaseOwner, null);
  assert.ok(new Date(failed.nextRunAt) > now);
});

test("单个事件触发器失败不会阻断同事件的其他安全触发器", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T04:45:00.000Z");
  for (const [id, requesterId] of [["a-invalid", "intruder"], ["z-valid", "owner"]]) {
    store.createWorkTrigger({
      version: 1, id, projectId: manifest.projectId,
      recipeId: "project-follow-up", requesterId, kind: "event", enabled: true,
      event: { type: "meeting.ended" }, values: { projectFocus: id },
    }, "owner", now);
  }
  const results = await ingestProactiveEvent({
    store,
    manifests: new Map([[manifest.projectId, manifest]]),
    recipes: await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)),
    owner: "meeting-adapter",
    now,
    event: { id: "meeting-isolation", type: "meeting.ended", source: "meeting", occurredAt: now.toISOString(), payload: {} },
  });
  assert.deepEqual(results.map((item) => [item.triggerId, item.created]), [
    ["a-invalid", false],
    ["z-valid", true],
  ]);
  assert.equal(store.listWorkPlans({ limit: 10 }).length, 1);
});

test("隐私擦除要求先停用主动触发器并删除其运行账本", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T05:00:00.000Z");
  store.createWorkTrigger({
    version: 1, id: "privacy-trigger", projectId: manifest.projectId,
    recipeId: "project-follow-up", requesterId: "owner", kind: "event",
    enabled: true, event: { type: "meeting.ended" }, values: { projectFocus: "会议跟进" },
  }, "owner", now);
  const blocked = store.previewPrivacyErasure({ projectId: manifest.projectId }, new Date(now.getTime() + 1));
  assert.equal(blocked.blocked.workTriggers, 1);
  assert.equal(blocked.confirmation, null);
  store.setWorkTriggerEnabled("privacy-trigger", false, "owner", now);
  const preview = store.previewPrivacyErasure({ projectId: manifest.projectId }, new Date(now.getTime() + 1));
  assert.equal(preview.counts.workTriggers, 1);
  store.erasePrivacyData(
    { projectId: manifest.projectId }, preview.confirmation, "owner", new Date(now.getTime() + 1),
  );
  assert.equal(store.getWorkTrigger("privacy-trigger"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { startAdminServer } from "../src/admin-server.mjs";
import { adminHtml } from "../src/admin-ui.mjs";

test("管理台内嵌脚本可以被浏览器解析", () => {
  const script = adminHtml.match(
    /<script nonce="__NONCE__">([\s\S]*?)<\/script>/u,
  )?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /plan-revise/u);
  assert.match(script, /\/api\/targets\//u);
  assert.match(script, /\/api\/privacy\/preview/u);
  assert.doesNotMatch(script, /\/api\/privacy\/delete/u);
});

test("判断质量页支持连续复核并保留分歧说明门槛", () => {
  const script = adminHtml.match(
    /<script nonce="__NONCE__">([\s\S]*?)<\/script>/u,
  )?.[1];
  assert.ok(script);
  assert.match(adminHtml, /连续人工复核/u);
  assert.match(adminHtml, /与 AI 一致时直接保存并进入下一条/u);
  assert.match(script, /expected!==task\.shouldReply/u);
  assert.match(script, /state\.view!==['"]quality['"]&&!confirm/u);
  assert.match(script, /state\.qualitySession\.completed\+=1/u);
  assert.match(script, /state\.quality=await api\(['"]\/api\/quality['"]\)/u);
  assert.match(script, /aria-busy/u);
});

function fixture() {
  let paused = false;
  const scopedPauses = [];
  const decisions = [];
  const reviews = [];
  const task = { id: "task_1", status: "awaiting_approval", payload: { senderName: "测试人", content: "需要回复" }, result: { shouldReply: true, reply: "准备回复", riskLevel: "medium", reason: "需要确认", decisionSource: "model", decisionKind: "reply" }, created_at: "2026-08-04T00:00:00Z", updated_at: "2026-08-04T00:00:00Z" };
  const plan = { id: "plan_1", project_id: "project_1", objective: "发布修复", max_level: "L4", status: "awaiting_approval", policy_decision: "REQUIRE_APPROVAL", plan_hash: "0123456789abcdef", plan: { steps: [{ id: "step_1", capability: "production_deploy", description: "部署已审核版本", workingDirectory: "/tmp/project", inputs: { commandId: "deploy" }, expectedEvidence: "健康检查通过", rollback: "执行回滚命令" }] }, updated_at: "2026-08-04T00:00:00Z" };
  const store = {
    async health() {
      return { database: true, paused, tasks: { awaiting_approval: 1 }, pendingMessages: 0, checkpoints: [], heartbeats: {} };
    },
    async listWorkPlans() { return [plan]; },
    async listWorkPlanSteps() {
      return [{
        step_id: "step_1",
        status: "cancelled",
        evidence: {
          kind: "controlled_command",
          verification: "operator_interrupt_confirmed",
          terminationSignal: "SIGTERM",
          secretOutput: "不能出现在管理接口",
        },
        error: "operator_interrupted",
        started_at: "2026-08-04T00:00:00Z",
        completed_at: "2026-08-04T00:00:01Z",
      }];
    },
    async listMemories() { return []; },
    async memoryConflictMetrics() { return { candidates: 0, conflictCandidates: 0, duplicateCandidates: 0, activeConflictGroups: 0, conflictRate: null, healthy: true, items: [] }; },
    async listScopedPauses() { return scopedPauses; },
    async isScopedPaused(type, value) {
      return scopedPauses.some(
        (item) => item.type === type && item.value === value,
      );
    },
    async operationalMetrics() {
      return {
        availability: { availability: 1, targetMet: null, recordedSamples: 10, missingSamples: 0, trackingCoverage: 0.01, windowComplete: false },
        window: { since: "2026-08-04T00:00:00Z", until: "2026-08-05T00:00:00Z", dataComplete: true, truncated: {} },
        messageDetection: { samples: 1, p95Ms: 1000, targetMs: 5000, targetMet: true },
        messageCoverage: { checkedAt: "2026-08-05T00:00:00Z", dataComplete: true, sourceMessages: 10, missedBeforeRepair: 0, observedMissRate: 0, repairedMessages: 0, remainingMissing: 0, finalMissRate: 0, targetRate: 0.001, targetMet: true },
        lowRiskTasks: { samples: 1, successes: 1, successRate: 1, successRateTarget: 0.95, successRateTargetMet: true, durationSamples: 1, durationP95Ms: 60000, durationTargetMs: 120000, durationTargetMet: true, lifecycleSamples: 1, lifecycleP95Ms: 90000 },
        approvalWait: { samples: 1, p95Ms: 30000 },
        reliability: { duplicateSideEffects: 0, unknownSideEffects: 0, completedSideEffects: 1, sideEffectAuditCoverage: 1, codexTimeouts: 0, deadTasks: 0 },
      };
    },
    async previewPrivacyErasure(selector) {
      decisions.push({ type: "privacy-preview", selector });
      return {
        selector: { type: "person", fingerprint: "a".repeat(24) },
        counts: {
          tasks: 1,
          messages: 2,
          workPlans: 0,
          memories: 0,
          auditEvents: 1,
          identityReferences: 1,
        },
        blocked: { tasks: 0, messages: 0, workPlans: 0, scopedPauses: 0 },
        eligibleTotal: 5,
        blockedTotal: 0,
        confirmation: "ERASE-0123456789ABCDEF",
        snapshotDigest: "0".repeat(64),
        warning: "This permanently erases business content and cannot be undone.",
        unsafeExtraField: selector.personId,
      };
    },
    async setScopedPause(change) {
      decisions.push({ type: "scope", ...change });
      if (change.paused) scopedPauses.push({ ...change, updatedAt: new Date() });
      else {
        const index = scopedPauses.findIndex(
          (item) => item.type === change.type && item.value === change.value,
        );
        if (index >= 0) scopedPauses.splice(index, 1);
      }
      return change.paused;
    },
    async listTasks() { return [task]; },
    async getTask(id) { return id === task.id ? task : null; },
    async getWorkPlan(id) { return id === plan.id ? plan : null; },
    async decideTask(id, decision) { decisions.push({ type: "task", id, ...decision }); return decision.decision; },
    async retryTask(id) { decisions.push({ type: "task-retry", id }); },
    async dismissDeadTask(id, actor, reason) { decisions.push({ type: "task-dismiss", id, actor, reason }); return "cancelled_operator"; },
    async decideWorkPlan(id, decision) { decisions.push({ type: "plan", id, ...decision }); return decision.decision; },
    async reviseWorkPlan(id, assessment, actor) {
      decisions.push({ type: "plan-revise", id, assessment, actor });
      return {
        id: "plan_revised",
        project_id: assessment.plan.projectId,
        objective: assessment.plan.objective,
        max_level: assessment.maxLevel,
        status: "awaiting_approval",
        policy_decision: assessment.decision,
        plan_hash: assessment.planHash,
        plan: assessment.plan,
        supersedes_work_plan_id: id,
        revision_actor: actor,
        updated_at: "2026-08-04T00:01:00Z",
      };
    },
    async requestWorkPlanCancellation(id, actor) { decisions.push({ type: "plan-cancel", id, actor }); return "cancelled"; },
    async listDecisionReviews({ taskId } = {}) {
      return taskId ? reviews.filter((review) => review.taskId === taskId) : reviews;
    },
    async upsertDecisionReview(id, review) {
      decisions.push({ type: "review", id, ...review });
      const saved = {
        ...review,
        taskId: id,
        predictedShouldReply: task.result.shouldReply,
        riskLevel: task.result.riskLevel,
        decisionSource: task.result.decisionSource,
        senderName: task.payload.senderName,
        senderUserId: "contact_1",
        conversationId: "direct_1",
        updatedAt: "2026-08-04T00:01:00Z",
      };
      const existing = reviews.findIndex((item) => item.taskId === id);
      if (existing >= 0) reviews.splice(existing, 1, saved);
      else reviews.push(saved);
      return saved;
    },
    async setPaused(value) { paused = value; },
    async isPaused() { return paused; },
    async close() {},
  };
  const config = {
    adminHost: "127.0.0.1", adminPort: 0,
    adminReadToken: "read-secret", adminWriteToken: "write-secret",
    dwsPath: "/bin/sh", codexPath: "/bin/sh", capabilities: new Set(["draft_reply"]),
    requiredComponents: [], requiredOperationalChecks: [], heartbeatStaleMs: 90_000, externalCheckStaleMs: 60_000,
    shadowMinimumSamples: 100, shadowMinimumNoReplyAccuracy: 0.95,
    approver: "test-reviewer",
    targetUserIds: ["contact_1"],
    targetGroupIds: ["group_1"],
  };
  return { store, config, decisions, task, plan };
}

test("管理台强制读取和写入令牌，并返回安全页面", async () => {
  const { store, config, plan } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(base);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /nonce-/u);
    assert.match(html, /AI 员工管理台/u);
    assert.doesNotMatch(html, /read-secret|write-secret/u);

    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    const read = { authorization: "Bearer read-secret" };
    const overview = await fetch(`${base}/api/overview`, { headers: read });
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).sendMode, "真实发送关闭");
    const capabilities = await fetch(`${base}/api/capabilities`, { headers: read });
    assert.equal(capabilities.status, 200);
    const capabilityBody = await capabilities.json();
    assert.equal(capabilityBody.catalog.some((item) => item.name === "production_deploy"), true);
    assert.equal(capabilityBody.global.find((item) => item.name === "work_plan_execution").enabled, false);
    store.listMemories = async () => [{
      id: "memory_1",
      type: "project",
      subject: "项目口径",
      statement: "需要核对来源。",
      status: "confirmed",
      sensitivity: "internal",
      project_id: "project_1",
      source_type: "document",
      source_id: "doc-1",
      source_version: "2",
      source_access_status: "not_required",
      source_access_reason: null,
      source_access_checked_at: null,
      source_access_expires_at: null,
      scope: { factKey: "release-rule" },
      confidence: 0.9,
      expires_at: null,
      updated_at: "2026-08-04T00:00:00Z",
    }];
    const memories = await fetch(`${base}/api/memories`, { headers: read });
    const memoryBody = await memories.json();
    assert.equal(memoryBody.items[0].sourceType, "document");
    assert.equal(memoryBody.items[0].sourceId, "doc-1");
    assert.equal(memoryBody.items[0].sourceAccessStatus, "not_required");
    assert.deepEqual(memoryBody.items[0].scope, { factKey: "release-rule" });
    const operations = await fetch(`${base}/api/operations`, { headers: read });
    assert.equal(operations.status, 200);
    assert.equal((await operations.json()).messageDetection.p95Ms, 1000);
    const plans = await fetch(`${base}/api/plans`, { headers: read });
    const planBody = await plans.json();
    assert.equal(
      planBody.items[0].steps[0].execution.verification,
      "operator_interrupt_confirmed",
    );
    assert.equal(planBody.items[0].steps[0].execution.error, "operator_interrupted");
    assert.doesNotMatch(JSON.stringify(planBody), /不能出现在管理接口/u);
    plan.status = "cancelled";
    plan.cancel_requested_at = "2026-08-04T00:00:00Z";
    const takeover = await fetch(`${base}/api/takeover`, { headers: read });
    assert.equal(takeover.status, 200);
    const takeoverBody = await takeover.json();
    assert.equal(takeoverBody.items[0].takeover.state, "interrupt_confirmed");
    assert.equal(takeoverBody.items[0].takeover.currentStep.terminationSignal, "SIGTERM");
    assert.doesNotMatch(JSON.stringify(takeoverBody), /不能出现在管理接口/u);
    assert.equal((await fetch(`${base}/api/system/pause`, {
      method: "POST", headers: { ...read, "content-type": "application/json" }, body: "{}",
    })).status, 403);
    const paused = await fetch(`${base}/api/system/pause`, {
      method: "POST",
      headers: { ...read, "content-type": "application/json", "x-ai-employee-write-token": "write-secret" },
      body: "{}",
    });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).paused, true);
  } finally {
    await service.stop("test");
  }
});

test("局部暂停只允许已配置范围并可恢复", async () => {
  const { store, config, decisions } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const endpoint = `http://127.0.0.1:${port}/api/scoped-pauses`;
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const denied = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "contact", value: "unknown", paused: true }),
    });
    assert.equal(denied.status, 400);
    const paused = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "contact",
        value: "contact_1",
        paused: true,
        reason: "人工接管",
      }),
    });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).paused, true);
    const listed = await fetch(endpoint, { headers });
    assert.equal((await listed.json()).items[0].value, "contact_1");
    const resumed = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "contact", value: "contact_1", paused: false }),
    });
    assert.equal(resumed.status, 200);
    assert.equal(decisions.at(-1).paused, false);
  } finally {
    await service.stop("test");
  }
});

test("监听范围只返回脱敏指纹并可暂停已配置联系人和群聊", async () => {
  const { store, config, decisions } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  const readHeaders = { authorization: "Bearer read-secret" };
  const writeHeaders = {
    ...readHeaders,
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const response = await fetch(`${base}/api/targets`, { headers: readHeaders });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.counts, { users: 1, groups: 1 });
    assert.equal(snapshot.rules.groupTrigger, "whitelist_mention_only");
    assert.equal(snapshot.rules.mentionRequiresReply, false);
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.items.every((item) => /^[a-f0-9]{16}$/u.test(item.fingerprint)), true);
    assert.doesNotMatch(JSON.stringify(snapshot), /contact_1|group_1/u);

    const group = snapshot.items.find((item) => item.kind === "group");
    const readOnly = await fetch(
      `${base}/api/targets/group/${group.fingerprint}/pause`,
      {
        method: "POST",
        headers: { ...readHeaders, "content-type": "application/json" },
        body: JSON.stringify({ paused: true }),
      },
    );
    assert.equal(readOnly.status, 403);

    const paused = await fetch(
      `${base}/api/targets/group/${group.fingerprint}/pause`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ paused: true, reason: "会议期间静默" }),
      },
    );
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).paused, true);
    assert.deepEqual(decisions.at(-1), {
      type: "group",
      value: "group_1",
      paused: true,
      actor: "admin-ui",
      reason: "会议期间静默",
    });

    const refreshed = await fetch(`${base}/api/targets`, { headers: readHeaders });
    const refreshedGroup = (await refreshed.json()).items.find(
      (item) => item.kind === "group",
    );
    assert.equal(refreshedGroup.paused, true);

    const missing = await fetch(
      `${base}/api/targets/group/${"0".repeat(16)}/pause`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ paused: true }),
      },
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "target_not_found");
  } finally {
    await service.stop("test");
  }
});

test("隐私删除管理台只允许双令牌预览并不暴露选择值或删除路由", async () => {
  const { store, config, decisions } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  const readHeaders = {
    authorization: "Bearer read-secret",
    "content-type": "application/json",
  };
  const writeHeaders = {
    ...readHeaders,
    "x-ai-employee-write-token": "write-secret",
  };
  try {
    const selector = { personId: "private-user-id" };
    const readOnly = await fetch(`${base}/api/privacy/preview`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify(selector),
    });
    assert.equal(readOnly.status, 403);
    assert.equal(decisions.length, 0);

    const invalid = await fetch(`${base}/api/privacy/preview`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ personId: "private-user-id", projectId: "project_1" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "privacy_selector_invalid");
    assert.equal(decisions.length, 0);

    const preview = await fetch(`${base}/api/privacy/preview`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(selector),
    });
    assert.equal(preview.status, 200);
    const body = await preview.json();
    assert.equal(body.selector.fingerprint, "a".repeat(24));
    assert.equal(body.confirmation, "ERASE-0123456789ABCDEF");
    assert.equal(body.eligibleTotal, 5);
    assert.equal(Object.hasOwn(body, "unsafeExtraField"), false);
    assert.doesNotMatch(JSON.stringify(body), /private-user-id/u);
    assert.deepEqual(decisions, [{ type: "privacy-preview", selector }]);

    const deletion = await fetch(`${base}/api/privacy/delete`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ ...selector, confirmation: body.confirmation }),
    });
    assert.equal(deletion.status, 404);
    assert.deepEqual(decisions, [{ type: "privacy-preview", selector }]);
  } finally {
    await service.stop("test");
  }
});

test("管理台拒绝非回环监听和缺失令牌", async () => {
  const first = fixture();
  first.config.adminHost = "0.0.0.0";
  await assert.rejects(startAdminServer(first), /loopback-only/u);
  const second = fixture();
  second.config.adminReadToken = null;
  await assert.rejects(startAdminServer(second), /tokens are required/u);
});

test("任务审批绑定当前草稿哈希", async () => {
  const { store, config, decisions } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const endpoint = `http://127.0.0.1:${port}/api/tasks/task_1/decision`;
  const headers = { authorization: "Bearer read-secret", "x-ai-employee-write-token": "write-secret", "content-type": "application/json" };
  try {
    const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers });
    const current = (await tasks.json()).items[0];
    const stale = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ decision: "approved", draftSha256: "stale" }) });
    assert.equal(stale.status, 409);
    assert.equal(decisions.length, 0);
    const approved = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ decision: "approved", draftSha256: current.draftSha256 }) });
    assert.equal(approved.status, 200);
    assert.equal(decisions[0].decision, "approved");
  } finally {
    await service.stop("test");
  }
});

test("管理台可以审计关闭死亡任务而不触发重试", async () => {
  const { store, config, decisions, task } = fixture();
  task.status = "dead";
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/tasks/task_1/dismiss`,
      { method: "POST", headers, body: JSON.stringify({ reason: "确认不再重试" }) },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "cancelled_operator");
    assert.deepEqual(decisions[0], {
      type: "task-dismiss",
      id: "task_1",
      actor: "admin-ui",
      reason: "确认不再重试",
    });
  } finally {
    await service.stop("test");
  }
});

test("计划审批绑定当前完整计划哈希", async () => {
  const { store, config, decisions, plan } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const endpoint = `http://127.0.0.1:${port}/api/plans/plan_1/decision`;
  const headers = { authorization: "Bearer read-secret", "x-ai-employee-write-token": "write-secret", "content-type": "application/json" };
  try {
    const stale = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ decision: "approved", planHash: "stale" }) });
    assert.equal(stale.status, 409);
    assert.equal(decisions.length, 0);
    const approved = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ decision: "approved", planHash: plan.plan_hash }) });
    assert.equal(approved.status, 200);
    assert.equal(decisions[0].decision, "approved");
  } finally {
    await service.stop("test");
  }
});

test("计划取消绑定当前计划哈希", async () => {
  const { store, config, decisions, plan } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const endpoint = `http://127.0.0.1:${port}/api/plans/plan_1/cancel`;
  const headers = { authorization: "Bearer read-secret", "x-ai-employee-write-token": "write-secret", "content-type": "application/json" };
  try {
    const stale = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ planHash: "stale" }) });
    assert.equal(stale.status, 409);
    assert.equal(decisions.length, 0);
    const cancelled = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ planHash: plan.plan_hash }) });
    assert.equal(cancelled.status, 200);
    assert.equal(decisions[0].type, "plan-cancel");
  } finally {
    await service.stop("test");
  }
});

test("计划修订绑定旧哈希、保留来源并形成新的待审批计划", async () => {
  const { store, config, decisions, plan } = fixture();
  plan.objective = "整理方案";
  plan.max_level = "L1";
  plan.plan = {
    version: 1,
    projectId: "project_1",
    requesterId: "requester_1",
    sourceTaskId: "task_1",
    objective: "整理方案",
    steps: [{
      id: "draft",
      capability: "document_draft",
      description: "形成方案草稿",
      workingDirectory: null,
      inputs: {},
      expectedEvidence: "草稿内容",
      rollback: null,
    }],
  };
  const manifest = {
    version: 1,
    projectId: "project_1",
    name: "测试项目",
    rootDirectory: "/tmp/project",
    requesters: ["requester_1"],
    capabilities: { document_draft: { mode: "automatic" } },
  };
  const service = await startAdminServer({
    store,
    config,
    manifestLoader: async () => new Map([[manifest.projectId, manifest]]),
  });
  const { port } = service.server.address();
  const endpoint = `http://127.0.0.1:${port}/api/plans/plan_1/revise`;
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  const revisedPlan = {
    objective: "整理并复核方案",
    steps: [{
      ...plan.plan.steps[0],
      description: "形成并复核方案草稿",
    }],
  };
  try {
    const stale = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ currentPlanHash: "stale", plan: revisedPlan }),
    });
    assert.equal(stale.status, 409);
    assert.equal(decisions.length, 0);
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ currentPlanHash: plan.plan_hash, plan: revisedPlan }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plan.status, "awaiting_approval");
    assert.equal(body.plan.supersedesWorkPlanId, plan.id);
    assert.equal(decisions[0].type, "plan-revise");
    assert.equal(decisions[0].assessment.plan.requesterId, "requester_1");
    assert.equal(decisions[0].assessment.plan.sourceTaskId, "task_1");
    assert.equal(decisions[0].assessment.plan.objective, "整理并复核方案");
  } finally {
    await service.stop("test");
  }
});

test("人工判断标注绑定当前决策哈希", async () => {
  const { store, config, decisions } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  const endpoint = `${base}/api/tasks/task_1/review`;
  const headers = { authorization: "Bearer read-secret", "x-ai-employee-write-token": "write-secret", "content-type": "application/json" };
  try {
    const pendingQuality = await fetch(`${base}/api/quality`, { headers });
    const pendingReport = await pendingQuality.json();
    assert.equal(pendingReport.queue.length, 1);
    assert.deepEqual(pendingReport.queue[0].priorityReasons, ["模型判断"]);
    const taskResponse = await fetch(`${base}/api/tasks`, { headers });
    const task = (await taskResponse.json()).items[0];
    const stale = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expectedShouldReply: false, decisionSha256: "stale" }) });
    assert.equal(stale.status, 409);
    const missingNote = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expectedShouldReply: false, decisionSha256: task.decisionSha256 }) });
    assert.equal(missingNote.status, 400);
    const reviewed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expectedShouldReply: false, decisionSha256: task.decisionSha256, note: "这条消息已经闭环" }) });
    assert.equal(reviewed.status, 200);
    assert.equal(decisions.at(-1).type, "review");
    const quality = await fetch(`${base}/api/quality`, { headers });
    assert.equal(quality.status, 200);
    const report = await quality.json();
    assert.equal(report.accepted, false);
    assert.equal(report.reviewed, 1);
    assert.equal(report.gates.coverage, true);
    assert.equal(report.queue.length, 0);
    assert.equal(
      report.breakdown.some(
        (row) => row.dimension === "判断来源" && row.label === "model",
      ),
      true,
    );
  } finally {
    await service.stop("test");
  }
});

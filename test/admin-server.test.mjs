import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startAdminServer } from "../src/admin-server.mjs";
import { adminHtml } from "../src/admin-ui.mjs";
import { personalDashboardHtml } from "../src/personal-dashboard-ui.mjs";
import { draftSha256 } from "../src/decision-quality.mjs";
import { Store } from "../src/store.mjs";
import { validateProjectManifest } from "../src/capability-policy.mjs";
import { createAdminPasswordHash } from "../src/admin-session-auth.mjs";

const execFileAsync = promisify(execFile);
const adminLoginPassword = "correct horse battery staple";
const adminPasswordHash = await createAdminPasswordHash(adminLoginPassword, {
  identifiers: ["ruiwang", "ruiwang@example.com"],
  salt: Buffer.alloc(16, 13),
});

test("管理台内嵌脚本可以被浏览器解析", () => {
  const script = adminHtml.match(
    /<script nonce="__NONCE__">([\s\S]*?)<\/script>/u,
  )?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /plan-revise/u);
  assert.match(script, /\/api\/targets\//u);
  assert.match(script, /\/api\/privacy\/preview/u);
  assert.match(script, /AbortSignal\.timeout\(10000\)/u);
  assert.match(script, /请求超时，请确认服务状态后重试/u);
  assert.match(script, /memoryRows\(\)\)\+'<\/section>'/u);
  assert.match(script, /conflictIds\.length===0/u);
  assert.match(script, /candidate\?\.conflict\?\.conflicts\?\.find/u);
  assert.match(script, /historical_project_import:'历史项目导入'/u);
  assert.match(script, /sourceQuoteSha256/u);
  assert.match(adminHtml, /用户名或邮箱/u);
  assert.match(adminHtml, /再次输入密码/u);
  assert.match(adminHtml, /首次设置验证（只需这一次）/u);
  assert.match(script, /\/api\/auth\/register/u);
  assert.match(script, /\/api\/auth\/login/u);
  assert.match(script, /\/api\/auth\/session/u);
  assert.match(script, /X-Foursday-CSRF/u);
  assert.match(script, /foursday-read/u);
  assert.doesNotMatch(script, /sessionStorage\.setItem\([^)]*password/iu);
  assert.match(script, /clearBrowserTokens/u);
  assert.doesNotMatch(script, /\/api\/privacy\/delete/u);
});

test("个人工作台脚本可解析并展示四项个人闭环", () => {
  const script = personalDashboardHtml.match(
    /<script nonce="__NONCE__">([\s\S]*?)<\/script>/u,
  )?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(personalDashboardHtml, /项目接入向导/u);
  assert.match(personalDashboardHtml, /可用配方/u);
  assert.match(personalDashboardHtml, /本周返还/u);
  assert.match(personalDashboardHtml, /本周工作返还队列/u);
  assert.match(personalDashboardHtml, /周目标进度/u);
  assert.match(personalDashboardHtml, /本周已验证自动化率/u);
  assert.match(script, /\/api\/projects\/onboarding/u);
  assert.match(script, /\/api\/time-returns/u);
  assert.match(script, /完整回读证据与本人确认/u);
  assert.match(script, /AI 交付后实际用于阅读、核对、补充和修改/u);
  assert.match(script, /不是假设你从头亲自完成/u);
  assert.match(script, /evidencePreviews/u);
  assert.match(script, /设为定时工作/u);
  assert.match(script, /\/api\/triggers/u);
  assert.match(personalDashboardHtml, /项目记忆自动同步/u);
  assert.match(personalDashboardHtml, /工作台不会替你扩大权限/u);
  assert.match(personalDashboardHtml, /设置项目记忆范围/u);
  assert.match(script, /\/memory-settings\/preview/u);
  assert.match(script, /\/memory-settings\/apply/u);
  assert.match(personalDashboardHtml, /memory-settings-confirmation/u);
  assert.match(script, /全局能力仍关闭/u);
  assert.match(script, /sync\.sourcePaths/u);
  assert.match(script, /conflictsPendingReview/u);
  assert.match(script, /weeklyDelegationCard/u);
  assert.match(script, /只规划，不执行/u);
  assert.match(script, /未验证配方不计入预计返还/u);
  assert.match(personalDashboardHtml, /审阅受控计划/u);
  assert.match(personalDashboardHtml, /预览不会写入计划账本/u);
  assert.match(script, /\/preview/u);
  assert.match(personalDashboardHtml, /确认登记计划/u);
  assert.match(script, /planHash:preview\.planHash/u);
  assert.match(script, /登记不等于批准或执行/u);
  assert.match(personalDashboardHtml, /导入历史项目/u);
  assert.match(personalDashboardHtml, /确认导入待审候选/u);
  assert.match(script, /\/api\/projects\/import\/preview/u);
  assert.match(script, /\/api\/projects\/import\/apply/u);
  assert.match(script, /正式记忆仍为 0/u);
  assert.match(personalDashboardHtml, /用户名或邮箱/u);
  assert.match(personalDashboardHtml, /先创建本机账户/u);
  assert.match(script, /\/api\/auth\/login/u);
  assert.match(script, /\/api\/auth\/session/u);
  assert.match(script, /X-Foursday-CSRF/u);
  assert.doesNotMatch(script, /sessionStorage\.setItem\([^)]*password/iu);
  assert.match(personalDashboardHtml, /审阅项目记忆同步/u);
  assert.match(script, /\/memory-sync\/preview/u);
  assert.match(script, /\/memory-sync\/apply/u);
  assert.match(script, /既有授权允许/u);
  assert.match(script, /timeoutMs:610000/u);
  assert.match(personalDashboardHtml, /待审项目记忆/u);
  assert.match(script, /data-memory-decision/u);
  assert.match(script, /decision==='replaced'/u);
  assert.match(script, /明确用候选替代这条事实/u);
  assert.match(personalDashboardHtml, /工作委托单/u);
  assert.match(personalDashboardHtml, /首次运行时间（本机时间）/u);
  assert.match(script, /recipeInputField/u);
  assert.match(script, /readHandoffValues/u);
  assert.match(script, /每天最多运行次数必须是 1～100/u);
  assert.match(script, /保存为停用主动工作/u);
  assert.match(script, /planHash:preview\.planHash/u);
  assert.doesNotMatch(script, /prompt\(input\.description\)/u);
});

test("配方先只读预览，再按精确哈希登记且不自动执行", async () => {
  const { store, config } = fixture();
  const registered = [];
  store.registerWorkPlan = async (assessment) => {
    registered.push(assessment.planHash);
    return {
      id: `plan_${assessment.planHash.slice(0, 24)}`,
      project_id: assessment.plan.projectId,
      objective: assessment.plan.objective,
      max_level: assessment.maxLevel,
      status: assessment.decision === "ALLOW" ? "ready" : "awaiting_approval",
      policy_decision: assessment.decision,
      plan_hash: assessment.planHash,
      plan: assessment.plan,
      updated_at: "2026-08-13T08:00:00.000Z",
    };
  };
  const manifest = {
    version: 1,
    projectId: "project_1",
    name: "项目",
    rootDirectory: "/tmp/project",
    requesters: ["owner"],
    profile: {
      objective: "完成项目跟进",
      successCriteria: [],
      milestones: [],
      collaborationObjects: [],
      selectedRecipeIds: ["project-follow-up"],
      memoryScope: { allowedTypes: ["project"], retentionDays: 90 },
    },
    capabilities: {
      research: { mode: "automatic" },
      document_draft: { mode: "automatic" },
    },
  };
  const service = await startAdminServer({
    store,
    config,
    manifestLoader: async () => new Map([[manifest.projectId, manifest]]),
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const readHeaders = {
    authorization: "Bearer read-secret",
    "content-type": "application/json",
  };
  const writeHeaders = {
    ...readHeaders,
    "x-foursday-write-token": "write-secret",
  };
  const endpoint = `${base}/api/projects/project_1/recipes/project-follow-up`;
  const requestBody = { values: { projectFocus: "本周交付" } };
  try {
    const previewResponse = await fetch(`${endpoint}/preview`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify(requestBody),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.schema, "foursday-recipe-plan-preview/v1");
    assert.match(preview.planHash, /^[a-f0-9]{64}$/u);
    assert.equal(preview.registration.registered, false);
    assert.equal(preview.execution.started, false);
    assert.equal(preview.execution.enabled, false);
    assert.equal(preview.approvalRequired, true);
    assert.equal(preview.decision, "REQUIRE_APPROVAL");
    assert.equal(preview.steps.length, 2);
    assert.equal(preview.steps.every((step) => step.sideEffect === false), true);
    assert.equal(registered.length, 0);

    const missingWrite = await fetch(`${endpoint}/instantiate`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify({ ...requestBody, planHash: preview.planHash }),
    });
    assert.equal(missingWrite.status, 403);
    assert.equal(registered.length, 0);

    const missingHash = await fetch(`${endpoint}/instantiate`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(requestBody),
    });
    assert.equal(missingHash.status, 400);
    assert.equal((await missingHash.json()).error, "reviewed_plan_hash_required");
    assert.equal(registered.length, 0);

    const stale = await fetch(`${endpoint}/instantiate`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ ...requestBody, planHash: "0".repeat(64) }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "recipe_plan_changed_review_again");
    assert.equal(registered.length, 0);

    const created = await fetch(`${endpoint}/instantiate`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ ...requestBody, planHash: preview.planHash }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.plan.planHash, preview.planHash);
    assert.equal(createdBody.plan.status, "awaiting_approval");
    assert.deepEqual(registered, [preview.planHash]);
  } finally {
    await service.stop("test");
  }
});

test("个人工作台历史项目导入先只读预览，再按摘要创建待审候选", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-admin-history-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "docs", "history.md"),
    "历史项目的发布必须完成目标系统回读。\n",
  );
  const projectsDirectory = join(root, ".runtime", "projects");
  const bundle = {
    schema: "foursday-historical-project-import/v1",
    project: {
      projectId: "legacy_project",
      name: "历史项目",
      rootDirectory: root,
      requesterIds: ["owner-1"],
      profile: {
        objective: "恢复历史项目上下文",
        successCriteria: ["历史事实可追溯"],
        milestones: ["完成首次导入"],
        collaborationObjects: ["repository"],
        selectedRecipeIds: ["project-follow-up"],
        memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 180 },
      },
    },
    sources: [{ id: "history", path: "docs/history.md" }],
    memories: [{
      type: "principle",
      statement: "历史项目的发布必须完成目标系统回读。",
      factKey: "delivery.readback_rule",
      sourceId: "history",
      sourceQuote: "历史项目的发布必须完成目标系统回读。",
      sensitivity: "internal",
      confidence: 1,
      retentionDays: 180,
    }],
  };
  const store = await new Store(join(root, ".runtime", "admin.sqlite")).open();
  const { config } = fixture();
  config.projectsDirectory = projectsDirectory;
  const service = await startAdminServer({ store, config });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const readHeaders = {
    authorization: "Bearer read-secret",
    "content-type": "application/json",
  };
  const writeHeaders = {
    ...readHeaders,
    "x-foursday-write-token": "write-secret",
  };
  try {
    const previewResponse = await fetch(`${base}/api/projects/import/preview`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify({ bundle }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.project.action, "create");
    assert.equal(preview.counts.sources, 1);
    assert.equal(preview.counts.candidates, 1);
    assert.equal(preview.candidates[0].statement, bundle.memories[0].statement);
    assert.equal(preview.databaseWrite, false);
    assert.equal(preview.memoriesConfirmed, 0);
    assert.equal(store.listMemories({ projectId: "legacy_project" }).length, 0);
    await assert.rejects(() => lstat(projectsDirectory));

    const missingWrite = await fetch(`${base}/api/projects/import/apply`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify({ bundle, confirmation: preview.confirmation }),
    });
    assert.equal(missingWrite.status, 403);

    const stale = await fetch(`${base}/api/projects/import/apply`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ bundle, confirmation: "IMPORT-WRONG" }),
    });
    assert.equal(stale.status, 409);
    assert.equal(store.listMemories({ projectId: "legacy_project" }).length, 0);
    await assert.rejects(() => lstat(projectsDirectory));

    const applied = await fetch(`${base}/api/projects/import/apply`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ bundle, confirmation: preview.confirmation }),
    });
    assert.equal(applied.status, 201);
    const result = await applied.json();
    assert.equal(result.manifestCreated, true);
    assert.equal(result.candidatesCreated, 1);
    assert.equal(result.memoriesConfirmed, 0);
    assert.equal(result.externalSystemsTouched, false);
    const manifest = JSON.parse(await readFile(
      join(projectsDirectory, "legacy_project.json"),
      "utf8",
    ));
    assert.equal(manifest.projectId, "legacy_project");
    const memories = store.listMemories({ projectId: "legacy_project" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].status, "proposed");
    assert.equal(store.searchMemories({ projectId: "legacy_project" }).length, 0);
  } finally {
    await service.stop("test");
  }
});

test("项目记忆同步预览由服务端短期绑定且应用不绕过现有授权", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-admin-memory-sync-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "docs", "decisions.md"),
    "The project must verify every external side effect by reading the target system.\n",
  );
  const project = validateProjectManifest({
    version: 1,
    projectId: "memory_sync_project",
    name: "Memory sync project",
    rootDirectory: root,
    requesters: ["owner-1"],
    profile: {
      objective: "Keep stable project knowledge current",
      successCriteria: ["Every formal fact has source evidence"],
      milestones: [],
      collaborationObjects: ["repository"],
      selectedRecipeIds: [],
      memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 180 },
    },
    capabilities: {
      project_memory_proposal: {
        mode: "approval_required",
        allowedFactKeyPrefixes: ["principle."],
        maxRetentionDays: 180,
        sourcePaths: ["docs/decisions.md"],
        autoConfirm: false,
      },
    },
  });
  let modelCalls = 0;
  const runtime = {
    async generateArtifact() {
      modelCalls += 1;
      const output = JSON.stringify({ memories: [{
        type: "principle",
        statement: "Every external side effect requires target-system read-back.",
        factKey: "principle.readback",
        sourceId: "source_0",
        sourceQuote: "The project must verify every external side effect by reading the target system.",
        sensitivity: "internal",
        confidence: 1,
        retentionDays: 180,
      }] });
      return { output, runtimeId: "test-runtime", sha256: "a".repeat(64) };
    },
  };
  const store = await new Store(join(root, "memory.sqlite")).open();
  const { config } = fixture();
  config.capabilities = new Set(["draft_reply", "project_memory_proposal"]);
  const service = await startAdminServer({
    store,
    config,
    manifestLoader: async () => new Map([[project.projectId, project]]),
    artifactRuntimeFactory: async () => runtime,
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const endpoint = `${base}/api/projects/${project.projectId}/memory-sync`;
  const readHeaders = {
    authorization: "Bearer read-secret",
    "content-type": "application/json",
  };
  const writeHeaders = {
    ...readHeaders,
    "x-foursday-write-token": "write-secret",
  };
  const generatePreview = async () => {
    const response = await fetch(`${endpoint}/preview`, {
      method: "POST", headers: writeHeaders, body: "{}",
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const readOnlyAttempt = await fetch(`${endpoint}/preview`, {
      method: "POST", headers: readHeaders, body: "{}",
    });
    assert.equal(readOnlyAttempt.status, 403);
    assert.equal(modelCalls, 0);

    const preview = await generatePreview();
    assert.equal(modelCalls, 1);
    assert.equal(preview.modelInvoked, true);
    assert.equal(preview.externalSystemsTouched, true);
    assert.equal(preview.databaseWrite, false);
    assert.equal(preview.confirmationRequired, true);
    assert.match(preview.previewId, /^[A-Za-z0-9_-]{32}$/u);
    assert.match(preview.confirmation, /^SYNC-[A-F0-9]{12}$/u);
    assert.equal(preview.candidates.length, 1);
    assert.equal(JSON.stringify(preview).includes(root), false);
    assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);

    const wrongConfirmation = await fetch(`${endpoint}/apply`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ previewId: preview.previewId, confirmation: "SYNC-WRONG" }),
    });
    assert.equal(wrongConfirmation.status, 409);
    assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);
    const consumed = await fetch(`${endpoint}/apply`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ previewId: preview.previewId, confirmation: preview.confirmation }),
    });
    assert.equal(consumed.status, 409);

    const current = await generatePreview();
    const applied = await fetch(`${endpoint}/apply`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ previewId: current.previewId, confirmation: current.confirmation }),
    });
    assert.equal(applied.status, 201);
    const result = await applied.json();
    assert.equal(result.candidatesCreated, 1);
    assert.equal(result.memoriesConfirmed, 0);
    assert.equal(result.reviewRequired, 1);
    const [memory] = store.listMemories({ projectId: project.projectId });
    assert.equal(memory.status, "proposed");
    assert.equal(store.searchMemories({ projectId: project.projectId }).length, 0);

    const replay = await fetch(`${endpoint}/apply`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ previewId: current.previewId, confirmation: current.confirmation }),
    });
    assert.equal(replay.status, 409);
  } finally {
    await service.stop("test");
  }
});

test("项目记忆设置先只读绑定来源，再用双令牌和精确摘要更新清单", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-admin-memory-settings-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "decisions.md"), "# Decisions\nKeep evidence.\n");
  const projectsDirectory = join(root, "projects");
  await mkdir(projectsDirectory, { mode: 0o700 });
  const project = validateProjectManifest({
    version: 1,
    projectId: "settings_project",
    name: "Settings project",
    rootDirectory: root,
    requesters: ["owner-1"],
    profile: {
      objective: "Configure bounded project memory",
      successCriteria: [], milestones: [], collaborationObjects: [],
      selectedRecipeIds: [],
      memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
    },
    capabilities: {
      project_memory_proposal: { mode: "disabled" },
      research: { mode: "automatic", timeoutMs: 120_000 },
    },
  });
  const manifestPath = join(projectsDirectory, `${project.projectId}.json`);
  await writeFile(manifestPath, `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 });
  const { store, config } = fixture();
  config.projectsDirectory = projectsDirectory;
  const service = await startAdminServer({ store, config });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const endpoint = `${base}/api/projects/${project.projectId}/memory-settings`;
  const readHeaders = {
    authorization: "Bearer read-secret",
    "content-type": "application/json",
  };
  const writeHeaders = {
    ...readHeaders,
    "x-foursday-write-token": "write-secret",
  };
  const settings = {
    mode: "approval_required",
    sourcePaths: ["docs/decisions.md"],
    allowedFactKeyPrefixes: ["decision."],
    maxRetentionDays: 90,
    autoConfirm: false,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  try {
    const before = await readFile(manifestPath, "utf8");
    const missingPreviewWrite = await fetch(`${endpoint}/preview`, {
      method: "POST", headers: readHeaders, body: JSON.stringify({ settings }),
    });
    assert.equal(missingPreviewWrite.status, 403);
    assert.equal(await readFile(manifestPath, "utf8"), before);
    const previewResponse = await fetch(`${endpoint}/preview`, {
      method: "POST", headers: writeHeaders, body: JSON.stringify({ settings }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.databaseWrite, false);
    assert.equal(preview.externalSystemsTouched, false);
    assert.equal(preview.effectiveAutomaticSync, false);
    assert.equal(preview.sources[0].path, "docs/decisions.md");
    assert.equal(await readFile(manifestPath, "utf8"), before);

    const missingWrite = await fetch(`${endpoint}/apply`, {
      method: "POST", headers: readHeaders,
      body: JSON.stringify({
        settings, digest: preview.digest, confirmation: preview.confirmation,
      }),
    });
    assert.equal(missingWrite.status, 403);
    assert.equal(await readFile(manifestPath, "utf8"), before);

    const stale = await fetch(`${endpoint}/apply`, {
      method: "POST", headers: writeHeaders,
      body: JSON.stringify({ settings, digest: preview.digest, confirmation: "wrong" }),
    });
    assert.equal(stale.status, 409);
    assert.equal(await readFile(manifestPath, "utf8"), before);

    const applied = await fetch(`${endpoint}/apply`, {
      method: "POST", headers: writeHeaders,
      body: JSON.stringify({
        settings, digest: preview.digest, confirmation: preview.confirmation,
      }),
    });
    assert.equal(applied.status, 200);
    const result = await applied.json();
    assert.equal(result.projectManifestWrite, true);
    assert.equal(result.databaseWrite, false);
    assert.equal(result.effectiveAutomaticSync, false);
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(current.capabilities.project_memory_proposal.mode, "approval_required");
    assert.deepEqual(
      current.capabilities.project_memory_proposal.sourcePaths,
      ["docs/decisions.md"],
    );
    assert.equal(current.capabilities.research.mode, "automatic");
    assert.equal((await lstat(manifestPath)).mode & 0o777, 0o600);
  } finally {
    await service.stop("test");
  }
});

test("项目接口只读展示自动记忆授权、同步状态和待审例外", async () => {
  const { store, config } = fixture();
  const manifest = {
    version: 1,
    projectId: "project_1",
    name: "项目",
    rootDirectory: "/tmp/project",
    requesters: ["owner"],
    profile: {
      objective: "持续更新项目记忆",
      successCriteria: [], milestones: [], collaborationObjects: [],
      selectedRecipeIds: ["project-memory-update"],
      memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
    },
    capabilities: {
      project_memory_proposal: {
        mode: "automatic",
        expiresAt: null,
        maxRuns: null,
        timeoutMs: 120_000,
        allowedFactKeyPrefixes: ["decision."],
        maxRetentionDays: 90,
        sourcePaths: ["docs/decisions.md"],
        autoConfirm: true,
      },
    },
  };
  store.listWorkPlans = async () => [];
  store.listMemories = async () => [{
    id: "memory-1", project_id: "project_1", status: "proposed",
    source_type: "historical_project_import", statement: "待审决策",
    scope: { factKey: "decision.release" },
  }];
  store.listTimeReturns = async () => [{
    projectId: "project_1",
    workPlanId: "completed-plan",
    recipeId: "project-memory-update",
    baselineMinutes: 60,
    humanActiveMinutes: 10,
    returnedMinutes: 50,
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
  }];
  store.getCheckpoint = async (key) => key.endsWith(":status")
    ? JSON.stringify({
        state: "review_required",
        lastCheckedAt: "2026-08-13T01:00:00.000Z",
        lastSuccessAt: "2026-08-13T01:00:00.000Z",
        sourceDigest: "b".repeat(64),
        candidatesCreated: 1,
        memoriesConfirmed: 0,
        reviewRequired: 1,
        errorCode: null,
      })
    : null;
  const service = await startAdminServer({
    store,
    config,
    manifestLoader: async () => new Map([[manifest.projectId, manifest]]),
    recipeLoader: async () => new Map([["project-memory-update", {
      id: "project-memory-update",
      name: "项目记忆更新",
      baselineMinutes: 60,
      baselineMethod: "user_confirmed",
      inputs: [],
      steps: [{ capability: "project_memory_proposal" }],
    }]]),
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const response = await fetch(`${base}/api/projects`, {
      headers: { authorization: "Bearer read-secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const [project] = body.items;
    assert.equal(project.memory.proposed, 1);
    assert.equal(project.memory.reviewItems.length, 1);
    assert.equal(project.memory.reviewItems[0].id, "memory-1");
    assert.equal(project.memorySync.mode, "automatic");
    assert.equal(project.memorySync.autoConfirm, true);
    assert.deepEqual(project.memorySync.sourcePaths, ["docs/decisions.md"]);
    assert.equal(project.memorySync.state, "review_required");
    assert.equal(project.memorySync.sourceDigestPrefix, "bbbbbbbbbbbb");
    assert.equal(project.memorySync.reviewRequired, 1);
    assert.equal(body.weeklyDelegation.weeklyTargetMinutes, 480);
    assert.equal(body.weeklyDelegation.weeklyReturnedMinutes, 50);
    assert.equal(body.weeklyDelegation.remainingMinutes, 430);
    assert.equal(body.weeklyDelegation.executionEnabled, false);
    assert.equal(body.weeklyDelegation.items[0].recipeId, "project-memory-update");
    assert.equal(body.weeklyDelegation.items[0].evidenceStatus, "verified_history");
    assert.equal(body.weeklyDelegation.items[0].conservativeReturnedMinutes, 50);
    assert.equal(
      body.weeklyDelegation.items[0].executionPath,
      "global_execution_disabled",
    );
    const weeklyResponse = await fetch(`${base}/api/weekly-plan`, {
      headers: { authorization: "Bearer read-secret" },
    });
    assert.equal(weeklyResponse.status, 200);
    const weekly = await weeklyResponse.json();
    assert.equal(weekly.weeklyReturnedMinutes, 50);
    assert.equal(weekly.remainingMinutes, 430);
    assert.equal(weekly.items[0].recipeId, "project-memory-update");
    assert.doesNotMatch(
      JSON.stringify(weekly),
      /持续更新项目记忆|待审决策|successCriteria|memorySync/u,
    );
  } finally {
    await service.stop("test");
  }
});

test("主动触发器默认停用、列表脱敏且启用受全局能力门禁", async () => {
  const { store, config, triggers } = fixture();
  const manifest = {
    version: 1, projectId: "project_1", name: "项目", rootDirectory: "/tmp/project",
    requesters: ["owner"],
    profile: {
      objective: "主动推进", successCriteria: [], milestones: [], collaborationObjects: [],
      selectedRecipeIds: ["project-follow-up"],
      memoryScope: { allowedTypes: ["project"], retentionDays: 90 },
    },
    capabilities: { research: { mode: "automatic" }, document_draft: { mode: "automatic" } },
  };
  const service = await startAdminServer({
    store,
    config,
    manifestLoader: async () => new Map([[manifest.projectId, manifest]]),
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const triggerBody = {
      id: "daily-follow-up", projectId: "project_1", recipeId: "project-follow-up",
      requesterId: "owner", kind: "schedule", values: { projectFocus: "每日风险" },
      schedule: { startsAt: "2026-08-13T01:00:00.000Z", intervalMinutes: 1_440 },
    };
    const previewResponse = await fetch(`${base}/api/projects/project_1/recipes/project-follow-up/preview`, {
      method: "POST", headers, body: JSON.stringify({ values: triggerBody.values }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    const stale = await fetch(`${base}/api/triggers`, {
      method: "POST", headers, body: JSON.stringify({ ...triggerBody, planHash: "0".repeat(64) }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "trigger_plan_changed_review_again");
    assert.equal(triggers.length, 0);
    const created = await fetch(`${base}/api/triggers`, {
      method: "POST", headers, body: JSON.stringify({ ...triggerBody, planHash: preview.planHash }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).status, "disabled");
    assert.equal(triggers[0].enabled, false);
    const listed = await fetch(`${base}/api/triggers`, { headers: { authorization: "Bearer read-secret" } });
    const item = (await listed.json()).items[0];
    assert.equal(item.id, "daily-follow-up");
    assert.equal(Object.hasOwn(item, "requesterId"), false);
    assert.equal(Object.hasOwn(item, "values"), false);
    const blocked = await fetch(`${base}/api/triggers/daily-follow-up/enabled`, {
      method: "POST", headers, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(blocked.status, 403);
    config.capabilities.add("proactive_work");
    const enabled = await fetch(`${base}/api/triggers/daily-follow-up/enabled`, {
      method: "POST", headers, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).status, "enabled");
  } finally {
    await service.stop("test");
  }
});

test("判断质量页使用内嵌两步表单连续复核", () => {
  const script = adminHtml.match(
    /<script nonce="__NONCE__">([\s\S]*?)<\/script>/u,
  )?.[1];
  assert.ok(script);
  assert.match(adminHtml, /连续人工复核/u);
  assert.match(adminHtml, /closed_loop/u);
  assert.match(adminHtml, /responseReasonCode/u);
  assert.match(adminHtml, /draftAssessment/u);
  assert.match(adminHtml, /回应必要性/u);
  assert.match(adminHtml, /草稿质量/u);
  assert.match(adminHtml, /quality-response-reason/u);
  assert.match(adminHtml, /quality-draft-reason/u);
  assert.match(adminHtml, /quality-submit/u);
  assert.match(adminHtml, /quality-detail/u);
  assert.match(adminHtml, /aria-pressed/u);
  assert.match(adminHtml, /建议回复准确率/u);
  assert.match(adminHtml, /业务放量总门禁/u);
  assert.match(adminHtml, /未知值也按未通过处理/u);
  assert.match(adminHtml, /开启自动发送或计划执行仍需单独审批/u);
  assert.match(adminHtml, /分歧原因/u);
  assert.doesNotMatch(script, /MutationObserver/u);
  assert.doesNotMatch(script, /function chooseReason/u);
  assert.doesNotMatch(script, /prompt\('第 2 步/u);
  assert.doesNotMatch(script, /review-reply|review-no-reply/u);
  assert.match(script, /f\.expectedShouldReply=value===['"]reply['"]/u);
  assert.match(script, /f\.completed\+=1/u);
  assert.match(script, /body\.draftSha256=current\.draftSha256/u);
  assert.match(script, /String\(current\.draft\|\|['"]['"]\)\.trim\(\)\.length>0/u);
  assert.match(script, /current\.responseReviewUsable===true/u);
  assert.match(script, /resumeDraft\?['"]draft['"]:['"]response['"]/u);
  assert.match(script, /state\.quality=await api\(['"]\/api\/quality['"]\)/u);
  assert.match(script, /aria-busy/u);
  assert.match(adminHtml, /标注只用于评估，不会批准草稿，也不会触发发送/u);
  assert.match(adminHtml, /请到“判断质量”统一标注/u);
  assert.match(adminHtml, /原消息证据/u);
  assert.match(adminHtml, /来源不可核对，禁止确认/u);
});

function fixture({ taskReply = "准备回复" } = {}) {
  let paused = false;
  const scopedPauses = [];
  const decisions = [];
  const reviews = [];
  const triggers = [];
  const task = { id: "task_1", status: "awaiting_approval", payload: { senderName: "测试人", content: "需要回复" }, result: { shouldReply: true, reply: taskReply, riskLevel: "medium", reason: "需要确认", decisionSource: "model", decisionKind: "reply" }, created_at: "2026-08-04T00:00:00Z", updated_at: "2026-08-04T00:00:00Z" };
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
    async listTimeReturns() { return []; },
    async listWorkTriggers({ projectId = null } = {}) {
      return triggers.filter((trigger) => !projectId || trigger.projectId === projectId);
    },
    async createWorkTrigger(trigger) {
      const saved = { ...trigger, status: trigger.enabled ? "enabled" : "disabled", nextRunAt: null, lastRunAt: null };
      triggers.push(saved);return saved;
    },
    async setWorkTriggerEnabled(id, enabled) {
      const trigger = triggers.find((item) => item.id === id);
      if (!trigger) throw new Error("Work trigger not found");
      trigger.status = enabled ? "enabled" : "disabled";trigger.enabled = enabled;return trigger;
    },
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
        memoryConflicts: { activeConflictGroups: 0 },
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
          capabilityBudgets: 0,
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
    async confirmMemory(id, actor, now, options = {}) {
      decisions.push({ type: "memory-confirm", id, actor, now, ...options });
      return "confirmed";
    },
    async revokeMemory(id, actor) {
      decisions.push({ type: "memory-revoke", id, actor });
      return "revoked";
    },
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
        decisionCurrent: true,
        draftPresent: String(task.result.reply ?? "").trim().length > 0,
        currentDraftSha256: draftSha256(task.result.reply ?? ""),
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
    adminLoginIdentifiers: ["ruiwang", "ruiwang@example.com"],
    adminPasswordHash,
    adminSessionTtlMs: 28_800_000,
    dwsPath: "/bin/sh", codexPath: "/bin/sh", capabilities: new Set(["draft_reply"]),
    requiredComponents: [], requiredOperationalChecks: [], heartbeatStaleMs: 90_000, externalCheckStaleMs: 60_000,
    shadowMinimumSamples: 100, shadowMinimumNoReplyAccuracy: 0.95,
    approver: "test-reviewer",
    targetUserIds: ["contact_1"],
    targetGroupIds: ["group_1"],
    recipesDirectory: new URL("../deploy/recipes/", import.meta.url),
    projectsDirectory: "/tmp/foursday-admin-test-projects",
  };
  return { store, config, decisions, task, plan, triggers };
}

test("管理台强制读取和写入令牌，并返回安全页面", async () => {
  const { store, config, plan, task } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(base);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /nonce-/u);
    assert.match(html, /Foursday 管理台/u);
    assert.match(html, /明确替代这条旧记忆/u);
    assert.doesNotMatch(html, /conflictIds\[0\]/u);
    assert.doesNotMatch(html, /read-secret|write-secret/u);
    const personal = await fetch(`${base}/projects`);
    assert.equal(personal.status, 200);
    assert.match(await personal.text(), /Foursday 个人工作台/u);

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
    const recipes = await fetch(`${base}/api/recipes`, { headers: read });
    assert.equal(recipes.status, 200);
    assert.deepEqual(
      (await recipes.json()).items.map((item) => item.id).sort(),
      [
        "code-delivery",
        "daily-report",
        "meeting-follow-up",
        "project-follow-up",
        "project-memory-update",
      ],
    );
    task.payload.messages = [{
      id: "source-message-1",
      senderName: "测试人",
      createTime: "2026-08-04T00:00:00Z",
      content: "以后请将回复控制在三句话以内。",
    }];
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
    }, {
      id: "memory_2",
      type: "person",
      subject: "contact_1",
      statement: "对方偏好三句话以内的回复。",
      status: "proposed",
      sensitivity: "internal",
      project_id: null,
      source_type: "dingtalk_message",
      source_id: "source-message-1",
      source_version: "task_1",
      source_access_status: "not_required",
      source_access_reason: null,
      source_access_checked_at: null,
      source_access_expires_at: null,
      scope: { factKey: "communication.reply_length" },
      confidence: 0.9,
      expires_at: "2026-11-04T00:00:00Z",
      updated_at: "2026-08-04T00:00:00Z",
    }];
    const memories = await fetch(`${base}/api/memories`, { headers: read });
    const memoryBody = await memories.json();
    assert.equal(memoryBody.items[0].sourceType, "document");
    assert.equal(memoryBody.items[0].sourceId, "doc-1");
    assert.equal(memoryBody.items[0].sourceAccessStatus, "not_required");
    assert.deepEqual(memoryBody.items[0].scope, { factKey: "release-rule" });
    assert.deepEqual(memoryBody.items[1].sourceEvidence, {
      status: "available",
      messageId: "source-message-1",
      senderName: "测试人",
      occurredAt: "2026-08-04T00:00:00Z",
      excerpt: "以后请将回复控制在三句话以内。",
    });
    const operations = await fetch(`${base}/api/operations`, { headers: read });
    assert.equal(operations.status, 200);
    const operationBody = await operations.json();
    assert.equal(operationBody.messageDetection.p95Ms, 1000);
    assert.equal(operationBody.businessAcceptance.accepted, false);
    assert.equal(
      operationBody.businessAcceptance.blockers.includes("availability"),
      true,
    );
    assert.equal(
      operationBody.businessAcceptance.blockers.includes("decisionQuality"),
      true,
    );
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

test("用户名或邮箱密码登录签发跨页面会话且写操作要求同源 CSRF", async () => {
  const { store, config } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  const originHeaders = {
    origin: base,
    "content-type": "application/json",
  };
  try {
    const methods = await fetch(`${base}/api/auth/methods`);
    assert.deepEqual(await methods.json(), {
      passwordLogin: true,
      registrationAvailable: false,
      registrationRequiresTokens: true,
      legacyTokenLogin: true,
      sessionTtlMs: 28_800_000,
    });

    const wrongOrigin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { ...originHeaders, origin: "http://example.com" },
      body: JSON.stringify({ identifier: "ruiwang", password: adminLoginPassword }),
    });
    assert.equal(wrongOrigin.status, 403);

    const unknown = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ identifier: "unknown", password: adminLoginPassword }),
    });
    assert.equal(unknown.status, 401);
    assert.equal((await unknown.json()).error, "invalid_credentials");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({
        identifier: "RUIWANG@example.com",
        password: adminLoginPassword,
      }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.identifier, "ruiwang@example.com");
    assert.match(loginBody.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/u);

    const session = await fetch(`${base}/api/auth/session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).identifier, "ruiwang@example.com");
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie } })).status, 200);

    const missingCsrf = await fetch(`${base}/api/system/pause`, {
      method: "POST",
      headers: { cookie, ...originHeaders },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error, "csrf_required");

    const pause = await fetch(`${base}/api/system/pause`, {
      method: "POST",
      headers: {
        cookie,
        ...originHeaders,
        "x-foursday-csrf": loginBody.csrfToken,
      },
      body: "{}",
    });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json()).paused, true);

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        ...originHeaders,
        "x-foursday-csrf": loginBody.csrfToken,
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/u);
    assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie } })).status, 401);
  } finally {
    await service.stop("test");
  }
});

test("首次网页注册要求双令牌、两次密码一致且成功后永久关闭入口", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-admin-register-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "production.json");
  const original = {
    DATABASE_URL: "env://DATABASE_URL",
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "env://ADMIN_READ_TOKEN",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "env://ADMIN_WRITE_TOKEN",
  };
  await writeFile(configPath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const { store, config } = fixture();
  config.adminLoginIdentifiers = [];
  config.adminPasswordHash = null;
  const service = await startAdminServer({ store, config, adminLoginConfigPath: configPath });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const originHeaders = { origin: base, "content-type": "application/json" };
  const body = {
    identifier: "RuiWang",
    email: "RuiWang@example.com",
    password: adminLoginPassword,
    passwordConfirmation: adminLoginPassword,
  };
  try {
    assert.deepEqual(await (await fetch(`${base}/api/auth/methods`)).json(), {
      passwordLogin: false,
      registrationAvailable: true,
      registrationRequiresTokens: true,
      legacyTokenLogin: true,
      sessionTtlMs: 28_800_000,
    });

    const wrongOrigin = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        ...originHeaders,
        origin: "http://example.com",
        authorization: "Bearer read-secret",
        "x-foursday-write-token": "write-secret",
      },
      body: JSON.stringify(body),
    });
    assert.equal(wrongOrigin.status, 403);

    const missingOwnership = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(missingOwnership.status, 403);
    assert.equal((await missingOwnership.json()).error, "bootstrap_authorization_failed");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), original);

    const mismatch = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        ...originHeaders,
        authorization: "Bearer read-secret",
        "x-foursday-write-token": "write-secret",
      },
      body: JSON.stringify({ ...body, passwordConfirmation: "different password value" }),
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error, "password_confirmation_mismatch");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), original);

    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        ...originHeaders,
        authorization: "Bearer read-secret",
        "x-foursday-write-token": "write-secret",
      },
      body: JSON.stringify(body),
    });
    assert.equal(registration.status, 201);
    const result = await registration.json();
    assert.equal(result.registered, true);
    assert.equal(result.identifier, "ruiwang");
    assert.match(result.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(registration.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/u);
    assert.doesNotMatch(JSON.stringify(result), /correct|horse|battery|staple|read-secret|write-secret|scrypt\$/u);

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.AI_EMPLOYEE_ADMIN_LOGIN_IDENTIFIERS, "ruiwang,ruiwang@example.com");
    assert.doesNotMatch(saved.AI_EMPLOYEE_ADMIN_PASSWORD_HASH, /correct|horse|battery|staple/u);
    assert.equal(saved.AI_EMPLOYEE_ADMIN_READ_TOKEN, original.AI_EMPLOYEE_ADMIN_READ_TOKEN);
    assert.equal(saved.AI_EMPLOYEE_ADMIN_WRITE_TOKEN, original.AI_EMPLOYEE_ADMIN_WRITE_TOKEN);
    assert.equal((await lstat(configPath)).mode & 0o077, 0);

    assert.deepEqual(await (await fetch(`${base}/api/auth/methods`)).json(), {
      passwordLogin: true,
      registrationAvailable: false,
      registrationRequiresTokens: true,
      legacyTokenLogin: true,
      sessionTtlMs: 28_800_000,
    });
    const secondRegistration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        ...originHeaders,
        authorization: "Bearer read-secret",
        "x-foursday-write-token": "write-secret",
      },
      body: JSON.stringify(body),
    });
    assert.equal(secondRegistration.status, 409);
    assert.equal((await secondRegistration.json()).error, "registration_closed");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({
        identifier: "RUIWANG@example.com",
        password: adminLoginPassword,
      }),
    });
    assert.equal(login.status, 200);
  } finally {
    await service.stop("test");
  }
});

test("Codex 只读挑战签名一次有效且不能重放", async () => {
  const { store, config } = fixture();
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const challengeResponse = await fetch(`${base}/api/auth/challenge`, {
      method: "POST",
    });
    assert.equal(challengeResponse.status, 200);
    const { nonce } = await challengeResponse.json();
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/u);
    const headers = {
      "x-ai-employee-challenge": nonce,
      "x-ai-employee-proof": createHmac("sha256", "read-secret")
        .update(`${nonce}\nGET\n/api/overview`)
        .digest("hex"),
    };
    assert.equal((await fetch(`${base}/api/overview`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/overview`, { headers })).status, 401);
  } finally {
    await service.stop("test");
  }
});

test("冲突记忆必须通过明确替代动作并展示旧事实", async () => {
  const { store, config, decisions } = fixture();
  const oldMemory = {
    id: "memory_old",
    type: "person",
    subject: "contact_1",
    subject_key: "subject-key",
    statement: "对方偏好详细回复。",
    status: "confirmed",
    sensitivity: "internal",
    project_id: null,
    source_type: "operator",
    source_id: "manual-old",
    source_version: null,
    source_access_status: "not_required",
    scope: { factKey: "communication.reply_length" },
    confidence: 1,
    updated_at: "2026-08-04T00:00:00Z",
  };
  const candidate = {
    ...oldMemory,
    id: "memory_new",
    statement: "对方偏好简短回复。",
    status: "proposed",
    source_id: "manual-new",
    updated_at: "2026-08-04T00:01:00Z",
  };
  store.listMemories = async () => [candidate, oldMemory];
  store.memoryConflictMetrics = async () => ({
    candidates: 1,
    conflictCandidates: 1,
    duplicateCandidates: 0,
    activeConflictGroups: 0,
    conflictRate: 1,
    healthy: true,
    items: [{
      memoryId: candidate.id,
      conflictIds: [oldMemory.id],
      duplicateIds: [],
      requiresResolution: true,
    }],
  });
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const listed = await fetch(`${base}/api/memories`, { headers });
    const body = await listed.json();
    assert.equal(body.items[0].conflict.conflicts[0].id, oldMemory.id);
    assert.equal(
      body.items[0].conflict.conflicts[0].statement,
      oldMemory.statement,
    );
    const endpoint = `${base}/api/memories/${candidate.id}/decision`;
    const implicitReplacement = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        decision: "confirmed",
        supersedesId: oldMemory.id,
      }),
    });
    assert.equal(implicitReplacement.status, 400);
    const missingTarget = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "replaced" }),
    });
    assert.equal(missingTarget.status, 400);
    const explicitReplacement = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        decision: "replaced",
        supersedesId: oldMemory.id,
      }),
    });
    assert.equal(explicitReplacement.status, 200);
    assert.equal(decisions.at(-1).type, "memory-confirm");
    assert.equal(decisions.at(-1).supersedesId, oldMemory.id);
  } finally {
    await service.stop("test");
  }
});

test("记忆冲突旧事实不在当前分页时仍会精确回读", async () => {
  const { store, config } = fixture();
  const oldMemory = {
    id: "memory_old_outside_page",
    type: "person",
    subject: "contact_1",
    statement: "对方偏好详细回复。",
    status: "confirmed",
    sensitivity: "internal",
    source_type: "operator",
    source_id: "manual-old",
    scope: { factKey: "communication.reply_length" },
  };
  const candidate = {
    ...oldMemory,
    id: "memory_new_on_page",
    statement: "对方偏好简短回复。",
    status: "proposed",
    source_id: "manual-new",
  };
  store.listMemories = async () => [
    candidate,
    ...Array.from({ length: 99 }, (_, index) => ({
      ...oldMemory,
      id: `unrelated_${index}`,
      subject: `unrelated_${index}`,
      statement: `无关事实 ${index}`,
      status: "proposed",
    })),
  ];
  store.getMemory = async (id) => id === oldMemory.id ? oldMemory : null;
  store.memoryConflictMetrics = async () => ({
    candidates: 1,
    conflictCandidates: 1,
    duplicateCandidates: 0,
    activeConflictGroups: 0,
    conflictRate: 1,
    healthy: true,
    items: [{
      memoryId: candidate.id,
      conflictIds: [oldMemory.id],
      duplicateIds: [],
      requiresResolution: true,
    }],
  });
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/memories?status=proposed`, {
      headers: { authorization: "Bearer read-secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items.length, 100);
    assert.equal(body.items.every((memory) => memory.status === "proposed"), true);
    assert.equal(body.items[0].conflict.conflicts[0].id, oldMemory.id);
    assert.equal(body.items[0].conflict.conflicts[0].statement, oldMemory.statement);
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
  task.last_error = "Codex draft execution failed [exit=1 private=不能返回]";
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const tasksResponse = await fetch(
      `http://127.0.0.1:${port}/api/tasks`,
      { headers },
    );
    const tasksBody = await tasksResponse.json();
    assert.equal(tasksBody.items[0].failureCode, "codex_execution_failed");
    assert.equal(JSON.stringify(tasksBody).includes("不能返回"), false);
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
    const incompleteDraftReview = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedShouldReply: true,
        decisionSha256: task.decisionSha256,
        draftSha256: task.draftSha256,
        draftAssessment: "needs_revision",
      }),
    });
    assert.equal(incompleteDraftReview.status, 400);
    const legacyDraftBypass = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedShouldReply: true,
        decisionSha256: task.decisionSha256,
        draftSha256: task.draftSha256,
        note: "旧版自由文本不能代替草稿质量评价",
      }),
    });
    assert.equal(legacyDraftBypass.status, 400);
    const staleDraft = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedShouldReply: true,
        decisionSha256: task.decisionSha256,
        draftSha256: "stale",
        draftAssessment: "usable",
      }),
    });
    assert.equal(staleDraft.status, 409);
    const usableDraftReview = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedShouldReply: true,
        decisionSha256: task.decisionSha256,
        draftSha256: task.draftSha256,
        draftAssessment: "usable",
      }),
    });
    assert.equal(usableDraftReview.status, 200);
    const draftQuality = await fetch(`${base}/api/quality`, { headers }).then(
      (response) => response.json(),
    );
    assert.equal(draftQuality.draftQuality.reviewed, 1);
    assert.equal(draftQuality.draftQuality.usabilityRate, 1);
    const stale = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expectedShouldReply: false, decisionSha256: "stale" }) });
    assert.equal(stale.status, 409);
    const missingNote = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expectedShouldReply: false, decisionSha256: task.decisionSha256 }) });
    assert.equal(missingNote.status, 400);
    const legacyDisagreementBypass = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedShouldReply: false,
        decisionSha256: task.decisionSha256,
        note: "旧版自由文本不能代替回应分歧原因",
      }),
    });
    assert.equal(legacyDisagreementBypass.status, 400);
    const reviewed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ expectedShouldReply: false, decisionSha256: task.decisionSha256, responseReasonCode: "closed_loop", detail: "这条消息已经闭环" }) });
    assert.equal(reviewed.status, 200);
    assert.equal(decisions.at(-1).type, "review");
    const quality = await fetch(`${base}/api/quality`, { headers });
    assert.equal(quality.status, 200);
    const report = await quality.json();
    assert.equal(report.accepted, false);
    assert.equal(report.reviewed, 1);
    assert.equal(report.gates.coverage, true);
    assert.equal(report.queue.length, 0);
    assert.equal(report.breakdown[0].replyAccuracy, 0);
    assert.deepEqual(report.disagreementReasons, [
      { code: "closed_loop", label: "闭环消息误触发", count: 1 },
    ]);
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

test("AI 判断应回复但没有生成草稿时不强迫虚构草稿评价", async () => {
  const { store, config } = fixture({ taskReply: "" });
  const service = await startAdminServer({ store, config });
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: "Bearer read-secret",
    "x-ai-employee-write-token": "write-secret",
    "content-type": "application/json",
  };
  try {
    const task = await fetch(`${base}/api/tasks`, { headers })
      .then((response) => response.json())
      .then((body) => body.items[0]);
    const reviewed = await fetch(`${base}/api/tasks/task_1/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedShouldReply: true,
        decisionSha256: task.decisionSha256,
      }),
    });
    assert.equal(reviewed.status, 200);
    const quality = await fetch(`${base}/api/quality`, { headers })
      .then((response) => response.json());
    assert.equal(quality.reviewed, 1);
    assert.equal(quality.draftQuality.reviewed, 0);
    assert.equal(quality.queue.length, 0);
  } finally {
    await service.stop("test");
  }
});

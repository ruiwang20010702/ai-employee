import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateProjectManifest } from "../src/capability-policy.mjs";
import {
  applyProjectMemorySync,
  previewProjectMemorySync,
} from "../src/project-memory-sync.mjs";
import { syncAutomaticProjectMemoriesOnce } from "../src/project-memory-sync-worker.mjs";
import { Store } from "../src/store.mjs";

const execFileAsync = promisify(execFile);
const now = new Date("2026-08-13T06:00:00.000Z");
const memoryCapabilities = new Set(["project_memory_proposal"]);

async function fixture(t, { mode = "automatic", autoConfirm = true } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "foursday-memory-sync-"));
  const root = await realpath(temporary);
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "decisions.md"), [
    "# Decisions",
    "The project must verify every external side effect by reading the target system.",
    "The current sprint ends on Friday.",
  ].join("\n"));
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
        mode,
        allowedFactKeyPrefixes: ["decision.", "principle."],
        maxRetentionDays: 180,
        sourcePaths: ["docs/decisions.md"],
        autoConfirm,
      },
    },
  });
  const store = await new Store(join(root, "memory.sqlite")).open();
  const runtime = {
    async generateArtifact({ workingDirectory }) {
      assert.notEqual(workingDirectory, root);
      assert.match(
        await readFile(join(workingDirectory, "docs", "decisions.md"), "utf8"),
        /target system/u,
      );
      await assert.rejects(
        () => readFile(join(workingDirectory, ".git", "config"), "utf8"),
        { code: "ENOENT" },
      );
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
      return { output, runtimeId: "test-runtime" };
    },
  };
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, store, runtime };
}

test("项目记忆同步默认预览且不写数据库", async (t) => {
  const { project, store, runtime } = await fixture(t);
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  assert.equal(generated.preview.modelInvoked, true);
  assert.equal(generated.preview.databaseWrite, false);
  assert.equal(generated.preview.candidates.length, 1);
  assert.equal(generated.preview.autoConfirmEligible, 1);
  assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);
});

test("一次性自动授权后低风险来源事实可自动转为正式记忆", async (t) => {
  const { project, store, runtime } = await fixture(t);
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  await assert.rejects(
    () => applyProjectMemorySync({ generated, project, store, now }),
    /global capability gate/u,
  );
  assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);
  const result = await applyProjectMemorySync({
    generated, project, store, capabilities: memoryCapabilities, now,
  });
  assert.equal(result.candidatesCreated, 1);
  assert.equal(result.memoriesConfirmed, 1);
  assert.equal(result.reviewRequired, 0);
  const [memory] = store.listMemories({ projectId: project.projectId });
  assert.equal(memory.status, "confirmed");
  assert.equal(memory.updated_by, "system:project-memory-sync");
});

test("需要审批的项目仍要求当前同步摘要确认", async (t) => {
  const { project, store, runtime } = await fixture(t, {
    mode: "approval_required",
    autoConfirm: false,
  });
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  await assert.rejects(
    () => applyProjectMemorySync({
      generated, project, store, capabilities: memoryCapabilities, now,
    }),
    /requires the current preview confirmation/u,
  );
  const result = await applyProjectMemorySync({
    generated,
    project,
    store,
    capabilities: memoryCapabilities,
    confirmation: generated.preview.confirmation,
    now,
  });
  assert.equal(result.memoriesConfirmed, 0);
  assert.equal(result.reviewRequired, 1);
  assert.equal(store.listMemories({ projectId: project.projectId })[0].status, "proposed");
});

test("自动同步不会覆盖冲突的正式项目事实", async (t) => {
  const { project, store, runtime } = await fixture(t);
  const first = await previewProjectMemorySync({ project, store, runtime, now });
  await applyProjectMemorySync({
    generated: first, project, store, capabilities: memoryCapabilities, now,
  });
  runtime.generateArtifact = async () => ({
    runtimeId: "test-runtime",
    output: JSON.stringify({ memories: [{
      type: "principle",
      statement: "Read-back is optional for internal tools.",
      factKey: "principle.readback",
      sourceId: "source_0",
      sourceQuote: "The project must verify every external side effect by reading the target system.",
      sensitivity: "internal",
      confidence: 1,
      retentionDays: 180,
    }] }),
  });
  const second = await previewProjectMemorySync({ project, store, runtime, now });
  assert.equal(second.preview.counts.conflicts, 1);
  const result = await applyProjectMemorySync({
    generated: second, project, store, capabilities: memoryCapabilities, now,
  });
  assert.equal(result.memoriesConfirmed, 0);
  assert.equal(result.reviewRequired, 1);
  assert.equal(
    store.listMemories({ projectId: project.projectId }).filter((item) => item.status === "confirmed").length,
    1,
  );
});

test("来源文件在预览后变化会阻止自动写入", async (t) => {
  const { root, project, store, runtime } = await fixture(t);
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  await writeFile(join(root, "docs", "decisions.md"), "# changed\n");
  await assert.rejects(
    () => applyProjectMemorySync({
      generated, project, store, capabilities: memoryCapabilities, now,
    }),
    /source_quote_not_found|changed after sync preview/u,
  );
  assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);
});

test("应用时重新拒绝伪造的来源路径和事实授权", async (t) => {
  const { project, store, runtime } = await fixture(t);
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  const forgedSource = structuredClone(generated);
  forgedSource.bundle.sources[0].path = "README.md";
  await assert.rejects(
    () => applyProjectMemorySync({
      generated: forgedSource, project, store, capabilities: memoryCapabilities, now,
    }),
    /sources no longer match/u,
  );
  const forgedFact = structuredClone(generated);
  forgedFact.bundle.memories[0].factKey = "risk.unapproved";
  await assert.rejects(
    () => applyProjectMemorySync({
      generated: forgedFact, project, store, capabilities: memoryCapabilities, now,
    }),
    /candidate exceeds/u,
  );
  assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);
});

test("候选写入期间来源变化时不自动确认", async (t) => {
  const { root, project, store, runtime } = await fixture(t);
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  const original = store.proposeHistoricalProjectMemories.bind(store);
  store.proposeHistoricalProjectMemories = (...args) => {
    const result = original(...args);
    return writeFile(join(root, "docs", "decisions.md"), "# changed during apply\n")
      .then(() => result);
  };
  const result = await applyProjectMemorySync({
    generated, project, store, capabilities: memoryCapabilities, now,
  });
  assert.equal(result.sourcesStable, false);
  assert.equal(result.memoriesConfirmed, 0);
  assert.equal(result.reviewRequired, 1);
  assert.equal(store.listMemories({ projectId: project.projectId })[0].status, "proposed");
});

test("自动确认必须绑定固定来源路径和 automatic 模式", () => {
  const base = {
    version: 1,
    projectId: "policy_project",
    name: "Policy project",
    rootDirectory: "/tmp/policy-project",
    requesters: ["owner"],
    profile: {
      objective: "test",
      successCriteria: [], milestones: [], collaborationObjects: [], selectedRecipeIds: [],
      memoryScope: { allowedTypes: ["project"], retentionDays: 90 },
    },
    capabilities: {
      project_memory_proposal: {
        mode: "automatic",
        allowedFactKeyPrefixes: ["decision."],
        maxRetentionDays: 90,
        autoConfirm: true,
      },
    },
  };
  assert.throws(() => validateProjectManifest(base), /requires fixed sourcePaths/u);
  base.capabilities.project_memory_proposal.sourcePaths = ["../outside.md"];
  assert.throws(() => validateProjectManifest(base), /normalized project-relative paths/u);
  base.capabilities.project_memory_proposal.sourcePaths = ["docs/decisions.md"];
  base.capabilities.project_memory_proposal.mode = "approval_required";
  assert.throws(() => validateProjectManifest(base), /requires automatic mode/u);
});

test("模型夹带未支持类型时逐条拒绝而不让整批固定来源同步失败", async (t) => {
  const { project, store, runtime } = await fixture(t);
  const original = runtime.generateArtifact.bind(runtime);
  runtime.generateArtifact = async (input) => {
    const valid = JSON.parse((await original(input)).output).memories[0];
    return {
      runtimeId: "test-runtime",
      output: JSON.stringify({ memories: [
        valid,
        {
          ...valid,
          type: "knowledge",
          factKey: "decision.unsupported_type",
        },
      ] }),
    };
  };
  const generated = await previewProjectMemorySync({ project, store, runtime, now });
  assert.equal(generated.preview.candidates.length, 1);
  assert.equal(generated.preview.rejectedByAuthorization, 1);
  const result = await applyProjectMemorySync({
    generated,
    project,
    store,
    capabilities: memoryCapabilities,
    now,
  });
  assert.equal(result.memoriesConfirmed, 1);
  assert.equal(result.reviewRequired, 1);
});

test("后台同步仅在授权来源变化时调用模型并在成功后推进检查点", async (t) => {
  const { root, project, store, runtime } = await fixture(t);
  let runtimeCalls = 0;
  const runtimeFactory = async () => {
    runtimeCalls += 1;
    return runtime;
  };
  const manifestLoader = async () => new Map([[project.projectId, project]]);
  const first = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: join(root, "unused"),
    runtimeFactory,
    capabilities: memoryCapabilities,
    manifestLoader,
    now,
  });
  assert.equal(first.syncedProjects, 1);
  assert.equal(first.memoriesConfirmed, 1);
  assert.equal(runtimeCalls, 1);
  const unchanged = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: join(root, "unused"),
    runtimeFactory,
    capabilities: memoryCapabilities,
    manifestLoader,
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(unchanged.unchangedProjects, 1);
  assert.equal(runtimeCalls, 1);
  await writeFile(
    join(root, "docs", "decisions.md"),
    "The project must verify every external side effect by reading the target system.\nNew decision.\n",
  );
  const changed = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: join(root, "unused"),
    runtimeFactory,
    capabilities: memoryCapabilities,
    manifestLoader,
    now: new Date(now.getTime() + 120_000),
  });
  assert.equal(changed.syncedProjects, 1);
  assert.equal(runtimeCalls, 2);
  assert.equal(changed.candidatesCreated, 0);
});

test("后台同步失败不推进来源检查点并会在下一轮重试", async (t) => {
  const { root, project, store, runtime } = await fixture(t);
  let attempts = 0;
  const manifestLoader = async () => new Map([[project.projectId, project]]);
  const runtimeFactory = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { generateArtifact: async () => { throw new Error("model unavailable"); } };
    }
    return runtime;
  };
  const failed = await syncAutomaticProjectMemoriesOnce({
    store, projectsDirectory: join(root, "unused"), runtimeFactory,
    capabilities: memoryCapabilities, manifestLoader, now,
  });
  assert.equal(failed.failures.length, 1);
  const recovered = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: join(root, "unused"),
    runtimeFactory,
    capabilities: memoryCapabilities,
    manifestLoader,
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(recovered.syncedProjects, 1);
  assert.equal(attempts, 2);
});

test("全局能力关闭时后台同步不读取项目、不调用模型也不写检查点", async (t) => {
  const { root, store } = await fixture(t);
  let manifestCalls = 0;
  let runtimeCalls = 0;
  const result = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: join(root, "unused"),
    runtimeFactory: async () => {
      runtimeCalls += 1;
      throw new Error("must not run");
    },
    manifestLoader: async () => {
      manifestCalls += 1;
      throw new Error("must not run");
    },
    now,
  });
  assert.equal(result.globallyEnabled, false);
  assert.equal(result.projectsInspected, 0);
  assert.equal(manifestCalls, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(store.listMemories({ projectId: "memory_sync_project" }).length, 0);
});

test("项目授权过期后手动和后台同步都停止且不调用模型", async (t) => {
  const { root, project, store, runtime } = await fixture(t);
  const expired = structuredClone(project);
  expired.capabilities.project_memory_proposal.expiresAt =
    new Date(now.getTime() - 1_000).toISOString();
  let runtimeCalls = 0;
  await assert.rejects(
    () => previewProjectMemorySync({
      project: expired,
      store,
      runtime: {
        async generateArtifact(...args) {
          runtimeCalls += 1;
          return runtime.generateArtifact(...args);
        },
      },
      now,
    }),
    /authorization has expired/u,
  );
  const summary = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: join(root, "unused"),
    runtimeFactory: async () => {
      runtimeCalls += 1;
      return runtime;
    },
    capabilities: memoryCapabilities,
    manifestLoader: async () => new Map([[expired.projectId, expired]]),
    now,
  });
  assert.equal(summary.expiredProjects, 1);
  assert.equal(summary.automaticProjects, 0);
  assert.equal(summary.failures.length, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(store.listMemories({ projectId: project.projectId }).length, 0);
});

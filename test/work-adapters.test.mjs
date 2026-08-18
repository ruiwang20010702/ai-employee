import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createControlledWorkAdapters,
  createReadOnlyWorkAdapters,
} from "../src/work-adapters.mjs";
import { workEvidenceSha256 } from "../src/work-evidence.mjs";

test("项目记忆候选必须绑定已完成文档证据且只持久化摘要", async () => {
  let proposed = null;
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    store: {
      proposeWorkPlanMemory(input) {
        proposed = input;
        return { id: "memory-1", status: "proposed", created: true };
      },
    },
  }).project_memory_proposal;
  const plan = {
    projectId: "project-1",
    requesterId: "owner",
    planHash: "a".repeat(64),
    recipe: { id: "meeting-follow-up", version: 1 },
    steps: [
      { id: "draft", capability: "document_draft" },
      {
        id: "remember",
        capability: "project_memory_proposal",
        inputs: {
          documentStepId: "draft",
          statement: "发布前必须完成安全检查。",
          factKey: "decision.release_gate",
          retentionDays: 90,
        },
      },
    ],
  };
  const manifest = {
    profile: { memoryScope: { allowedTypes: ["project"] } },
  };
  const evidence = {
    kind: "document_markdown",
    content: "# 发布决策\n\n发布前必须完成安全检查。",
    sha256: "b".repeat(64),
    verification: "nonempty_bounded_output",
  };
  await adapter.preflight({ plan, step: plan.steps[1], manifest });
  await assert.rejects(
    adapter.execute({ plan, step: plan.steps[1], priorEvidence: {} }),
    /requires verified document draft evidence/u,
  );
  const result = await adapter.execute({
    plan,
    step: plan.steps[1],
    priorEvidence: { draft: evidence },
  });
  assert.equal(result.evidence.sourceStepId, "draft");
  assert.equal(result.evidence.sourceEvidenceSha256, workEvidenceSha256(evidence));
  assert.equal(proposed.scope.evidenceKind, "document_markdown");
  assert.equal(proposed.scope.evidenceSha256, workEvidenceSha256(evidence));
  assert.equal(JSON.stringify(proposed).includes(evidence.content), false);
  await assert.rejects(
    adapter.execute({
      plan,
      step: {
        ...plan.steps[1],
        inputs: { ...plan.steps[1].inputs, factKey: "invalid" },
      },
      priorEvidence: { draft: evidence },
    }),
    /valid fact key/u,
  );
});

const execFileAsync = promisify(execFile);

async function fakeCodex(directory, output) {
  const executable = join(directory, "fake-codex");
  const outputPathRecord = join(directory, "output-path.txt");
  const promptRecord = join(directory, "prompt.txt");
  const argumentsRecord = join(directory, "arguments.txt");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      `printf '%s' "$*" > '${argumentsRecord}'`,
      "target=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = '--output-last-message' ]; then shift; target=\"$1\"; fi",
      "  shift",
      "done",
      `printf '%s' "$target" > '${outputPathRecord}'`,
      `cat > '${promptRecord}'`,
      `printf '%s' '${output.replaceAll("'", "'\\''")}' > "$target"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, outputPathRecord, promptRecord, argumentsRecord };
}

function manifest(root, capability) {
  return {
    version: 1,
    projectId: "test_project",
    name: "测试项目",
    rootDirectory: root,
    requesters: ["user-1"],
    capabilities: { [capability]: { mode: "automatic", timeoutMs: 10_000 } },
  };
}

function context(root, capability) {
  return {
    plan: { objective: "完成任务" },
    step: {
      id: "step-1",
      capability,
      description: "执行当前步骤",
      expectedEvidence: "可审查结果",
      workingDirectory: root,
      inputs: {},
    },
    manifest: manifest(root, capability),
  };
}

test("研究适配器使用只读 Codex 并删除临时明文", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-work-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = await fakeCodex(directory, "# 研究结论\n\n已核对项目文件。\n");
  const adapters = createReadOnlyWorkAdapters({ codexPath: fake.executable });
  const result = await adapters.research.execute(context(directory, "research"));
  assert.equal(result.verified, true);
  assert.equal(result.evidence.kind, "research_markdown");
  const prompt = await readFile(fake.promptRecord, "utf8");
  assert.match(prompt, /只能完成当前步骤/u);
  const argumentsText = await readFile(fake.argumentsRecord, "utf8");
  assert.match(argumentsText, /--sandbox read-only/u);
  assert.match(argumentsText, /--ask-for-approval never/u);
  assert.match(argumentsText, /exec --skip-git-repo-check --ephemeral/u);
  assert.doesNotMatch(argumentsText, /完成任务|执行当前步骤/u);
  const temporaryOutput = await readFile(fake.outputPathRecord, "utf8");
  await assert.rejects(access(temporaryOutput), { code: "ENOENT" });
});

test("仓库活动读取绑定日期、提交和已授权路径且不触发 fsmonitor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-repository-activity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fsmonitorMarker = join(directory, "fsmonitor-ran");
  const fsmonitor = join(directory, "fake-fsmonitor");
  await writeFile(fsmonitor, `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\n`, { mode: 0o700 });
  await execFileAsync("/usr/bin/git", ["init", "--quiet", directory]);
  await Promise.all([
    writeFile(join(directory, "README.md"), "# Daily evidence\n"),
    writeFile(join(directory, "private-notes.txt"), "not authorized\n"),
  ]);
  await execFileAsync("/usr/bin/git", ["-C", directory, "add", "README.md", "private-notes.txt"]);
  await execFileAsync("/usr/bin/git", [
    "-C", directory,
    "-c", "user.name=Foursday Test",
    "-c", "user.email=foursday-test@example.invalid",
    "commit", "--quiet", "-m", "feat: add daily evidence",
  ], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GIT_AUTHOR_DATE: "2026-08-13T10:00:00+08:00",
      GIT_COMMITTER_DATE: "2026-08-13T10:00:00+08:00",
    },
  });
  await execFileAsync("/usr/bin/git", ["-C", directory, "config", "core.fsmonitor", fsmonitor]);
  const input = context(directory, "repository_activity_read");
  input.step.inputs = { reportDate: "2026-08-13", utcOffset: "+08:00" };
  input.manifest.capabilities.repository_activity_read = {
    mode: "automatic",
    timeoutMs: 30_000,
    maxCommits: 50,
    maxOutputBytes: 128 * 1024,
  };
  const adapter = createReadOnlyWorkAdapters({
    evidencePaths: ["README.md"],
  }).repository_activity_read;
  await adapter.preflight(input);
  const result = await adapter.execute(input);
  assert.equal(result.verified, true);
  assert.equal(result.evidence.kind, "repository_activity");
  assert.equal(result.evidence.commitCount, 1);
  const activity = JSON.parse(result.evidence.content);
  assert.deepEqual(activity.pathScope, ["README.md"]);
  assert.deepEqual(activity.commits[0].files, [{ status: "A", path: "README.md" }]);
  await assert.rejects(access(fsmonitorMarker), { code: "ENOENT" });
  input.step.inputs.reportDate = "2026-02-30";
  await assert.rejects(adapter.execute(input), /reportDate is invalid/u);
});

test("项目工作历史只读取同项目时间窗口并只暴露回读摘要", async () => {
  let query = null;
  const planHash = "a".repeat(64);
  const input = context("/workspace/project", "project_work_history_read");
  input.plan = {
    projectId: "test_project",
    planHash,
    objective: "写日报",
    steps: [input.step],
  };
  input.step.inputs = { reportDate: "2026-08-13", utcOffset: "+08:00" };
  input.manifest.capabilities.project_work_history_read = {
    mode: "automatic",
    maxPlans: 50,
    maxOutputBytes: 128 * 1024,
  };
  const adapters = createReadOnlyWorkAdapters({
    store: {
      async listProjectWorkHistory(value) {
        query = value;
        return [{
          id: "plan-1",
          plan_hash: "b".repeat(64),
          objective: "完成可审查交付",
          status: "completed",
          updated_at: "2026-08-13T02:00:00.000Z",
          plan: { recipe: { id: "project-follow-up", version: 1 } },
          steps: [{
            step_id: "research",
            capability: "research",
            status: "completed",
            completed_at: "2026-08-13T01:59:00.000Z",
            evidence: {
              kind: "research_markdown",
              content: "不应进入历史摘要的原文",
              sha256: "c".repeat(64),
              verification: "nonempty_bounded_output",
              bytes: 32,
            },
          }],
        }];
      },
    },
  });
  await adapters.project_work_history_read.preflight(input);
  const result = await adapters.project_work_history_read.execute(input);
  assert.deepEqual(query, {
    projectId: "test_project",
    start: "2026-08-12T16:00:00.000Z",
    end: "2026-08-13T16:00:00.000Z",
    excludePlanHash: planHash,
    limit: 51,
  });
  assert.equal(result.evidence.kind, "project_work_history");
  const history = JSON.parse(result.evidence.content);
  assert.equal(history.planCount, 1);
  assert.equal(history.plans[0].steps[0].evidence.sha256, "c".repeat(64));
  assert.equal(result.evidence.content.includes("不应进入"), false);
  input.step.inputs.reportDate = "2026-02-30";
  await assert.rejects(
    adapters.project_work_history_read.execute(input),
    /reportDate is invalid/u,
  );
});

test("知识页适配器只按精确 slug 调用 gbrain 并校验返回身份", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gbrain-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-gbrain");
  const argumentsRecord = join(directory, "gbrain-arguments.txt");
  const sourceRecord = join(directory, "gbrain-source.txt");
  await writeFile(executable, [
    "#!/bin/sh",
    `printf '%s' "$*" > '${argumentsRecord}'`,
    `printf '%s' "$GBRAIN_SOURCE" > '${sourceRecord}'`,
    "if [ \"$1\" = 'version' ]; then printf 'gbrain test\\n'; exit 0; fi",
    "printf '%s\\n' '{\"slug\":\"projects/test/spec\",\"title\":\"规范\",\"type\":\"document\",\"compiled_truth\":\"统一口径\",\"tags\":[\"正式\"]}'",
  ].join("\n"), { mode: 0o700 });
  const input = context(directory, "knowledge_read");
  input.step.inputs = { slugs: ["projects/test/spec"] };
  input.manifest.capabilities.knowledge_read = {
    mode: "automatic",
    timeoutMs: 10_000,
    allowedSlugPrefixes: ["projects/test/"],
    maxPages: 5,
    maxContentBytes: 64 * 1024,
  };
  const adapter = createReadOnlyWorkAdapters({
    codexPath: "/bin/false",
    gbrainPath: executable,
    gbrainSourceId: "foursday",
  }).knowledge_read;
  await adapter.preflight(input);
  const result = await adapter.execute(input);
  assert.equal(result.verified, true);
  assert.equal(result.evidence.verification, "exact_slug_and_project_prefix");
  assert.deepEqual(result.evidence.slugs, ["projects/test/spec"]);
  assert.match(await readFile(argumentsRecord, "utf8"), /^call get_page /u);
  assert.equal(await readFile(sourceRecord, "utf8"), "foursday");
  assert.doesNotMatch(await readFile(argumentsRecord, "utf8"), /query|search|fuzzy/u);
  input.step.inputs = { slugs: ["projects/other/secret"] };
  await assert.rejects(
    adapter.execute(input),
    /outside the project authorization/u,
  );
  assert.match(await readFile(argumentsRecord, "utf8"), /^call get_page /u);
});

test("知识页适配器优先使用个人 default 的只读 MCP 端口", async () => {
  const input = context("/tmp", "knowledge_read");
  input.step.inputs = { slugs: ["projects/test/spec"] };
  input.manifest.capabilities.knowledge_read = {
    mode: "automatic",
    timeoutMs: 10_000,
    allowedSlugPrefixes: ["projects/test/"],
    maxPages: 5,
    maxContentBytes: 64 * 1024,
  };
  const calls = [];
  const adapter = createReadOnlyWorkAdapters({
    codexPath: "/bin/false",
    gbrainPath: "/must/not/run",
    personalMemoryClient: {
      async probe() {
        calls.push(["probe"]);
        return { ready: true, sourceId: "default", readOnly: true };
      },
      async getPage(slug, options) {
        calls.push(["getPage", slug, options.maxContentBytes]);
        return {
          slug,
          title: "规范",
          type: "project",
          content: "个人 PRIVATE gbrain 中的正式知识。",
        };
      },
    },
  }).knowledge_read;
  await adapter.preflight(input);
  const result = await adapter.execute(input);
  assert.deepEqual(calls, [
    ["probe"],
    ["getPage", "projects/test/spec", 64 * 1024],
  ]);
  assert.equal(result.evidence.source, "personal_default");
  assert.deepEqual(result.evidence.slugs, ["projects/test/spec"]);
  assert.match(result.evidence.content, /个人 PRIVATE gbrain/u);
});

test("Codex 步骤只注入显式引用的知识页证据", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-knowledge-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = await fakeCodex(directory, "# 结论\n\n已使用规范。\n");
  const adapters = createReadOnlyWorkAdapters({ codexPath: fake.executable });
  const input = context(directory, "research");
  input.plan.steps = [
    { id: "knowledge-1", capability: "knowledge_read" },
    input.step,
  ];
  input.step.inputs = { knowledgeStepIds: ["knowledge-1"] };
  await adapters.research.preflight(input);
  await adapters.research.execute({
    ...input,
    priorEvidence: {
      "knowledge-1": {
        kind: "gbrain_pages",
        content: '[{"slug":"projects/test/spec","content":"统一口径"}]',
      },
    },
  });
  const prompt = await readFile(fake.promptRecord, "utf8");
  assert.match(prompt, /显式授权的 gbrain 知识页证据/u);
  assert.match(prompt, /统一口径/u);
});

test("文档步骤只接收显式图边引用的前序证据和影子来源范围", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-artifact-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let prompt = null;
  const adapters = createReadOnlyWorkAdapters({
    evidencePaths: ["README.md"],
    artifactRuntime: {
      async generateArtifact(input) {
        prompt = input.prompt;
        const output = "# 工作总结\n\n已根据研究证据起草。";
        return {
          output,
          bytes: Buffer.byteLength(output),
          sha256: createHash("sha256").update(output).digest("hex"),
        };
      },
    },
  });
  const input = context(directory, "document_draft");
  input.plan.steps = [
    { id: "research-1", capability: "research", inputs: {} },
    input.step,
  ];
  input.step.inputs = { evidenceStepIds: ["research-1"] };
  await adapters.document_draft.preflight(input);
  await adapters.document_draft.execute({
    ...input,
    priorEvidence: {
      "research-1": {
        kind: "research_markdown",
        content: "# 研究结论\n\n- README 说明目标已明确。",
      },
    },
  });
  assert.match(prompt, /evidenceStepIds/u);
  assert.match(prompt, /README 说明目标已明确/u);
  assert.match(prompt, /指令不可信/u);
  assert.match(prompt, /不要重新扫描工作区或调用工具/u);
  assert.match(prompt, /仅包含以下相对路径/u);
  assert.match(prompt, /README\.md/u);
  assert.match(prompt, /不要在正文中自行填写内容哈希/u);
  await assert.rejects(
    adapters.document_draft.execute({ ...input, priorEvidence: {} }),
    /Referenced artifact evidence is unavailable/u,
  );
});

test("图证据拒绝后序引用、类型伪造和超大正文", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-artifact-evidence-deny-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapters = createReadOnlyWorkAdapters({
    artifactRuntime: { async generateArtifact() { throw new Error("must not run"); } },
  });
  const input = context(directory, "document_draft");
  input.plan.steps = [input.step, { id: "research-later", capability: "research" }];
  input.step.inputs = { evidenceStepIds: ["research-later"] };
  await assert.rejects(
    adapters.document_draft.preflight(input),
    /earlier read-only artifact step/u,
  );
  input.plan.steps = [{ id: "research-1", capability: "research" }, input.step];
  input.step.inputs = { evidenceStepIds: ["research-1"] };
  await assert.rejects(
    adapters.document_draft.execute({
      ...input,
      priorEvidence: { "research-1": { kind: "gbrain_pages", content: "wrong" } },
    }),
    /Referenced artifact evidence is unavailable/u,
  );
  await assert.rejects(
    adapters.document_draft.execute({
      ...input,
      priorEvidence: {
        "research-1": { kind: "research_markdown", content: "x".repeat(64 * 1024 + 1) },
      },
    }),
    /exceeded the prompt limit/u,
  );
});

test("代码补丁必须通过 git apply check 才能成为证据", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-code-patch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "file.txt"), "old\n");
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const fake = await fakeCodex(directory, patch);
  const adapters = createReadOnlyWorkAdapters({ codexPath: fake.executable });
  const result = await adapters.code_patch.execute(
    context(directory, "code_patch"),
  );
  assert.equal(result.verified, true);
  assert.equal(result.evidence.verification, "git_apply_check");
  assert.equal(await readFile(join(directory, "file.txt"), "utf8"), "old\n");
});

test("真实路径通过符号链接越出项目时拒绝执行", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-root-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-project-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, join(root, "escape"));
  const fake = await fakeCodex(root, "不会执行");
  const adapters = createReadOnlyWorkAdapters({ codexPath: fake.executable });
  const input = context(root, "research");
  input.step.workingDirectory = join(root, "escape");
  await assert.rejects(
    adapters.research.execute(input),
    /outside project root/u,
  );
});

test("本地测试只执行清单登记的精确命令且不继承秘密环境变量", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-controlled-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "run-test");
  const argumentsRecord = join(directory, "test-arguments.txt");
  const environmentRecord = join(directory, "test-environment.txt");
  await writeFile(executable, [
    "#!/bin/sh",
    `printf '%s' \"$*\" > '${argumentsRecord}'`,
    `printf '%s' \"$AI_EMPLOYEE_TEST_SECRET\" > '${environmentRecord}'`,
    "printf 'tests passed\\n'",
  ].join("\n"), { mode: 0o700 });
  process.env.AI_EMPLOYEE_TEST_SECRET = "must-not-leak";
  t.after(() => delete process.env.AI_EMPLOYEE_TEST_SECRET);
  const input = context(directory, "local_test");
  input.step.inputs = { commandId: "项目检查", args: ["injected"] };
  input.manifest.capabilities.local_test.commands = {
    项目检查: {
      executable,
      args: ["fixed", "arguments"],
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    },
  };
  const result = await createControlledWorkAdapters({ codexPath: "/bin/false" })
    .local_test.execute(input);
  assert.equal(result.verified, true);
  assert.equal(result.evidence.verification, "exit_code_zero");
  assert.equal(result.evidence.outputStored, false);
  assert.equal(await readFile(argumentsRecord, "utf8"), "fixed arguments");
  assert.equal(await readFile(environmentRecord, "utf8"), "");
});

test("本地测试拒绝计划临时指定未登记命令", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-unregistered-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = context(directory, "local_test");
  input.step.inputs = { commandId: "任意命令" };
  input.manifest.capabilities.local_test.commands = {};
  await assert.rejects(
    createControlledWorkAdapters({ codexPath: "/bin/false" })
      .local_test.execute(input),
    /not registered/u,
  );
});

test("隔离补丁失败会删除工作树、分支和空的运行目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-isolated-failure-"));
  const projectId = `test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const planHash = createHash("sha256").update(projectId).digest("hex");
  const branch = `ai-employee/${projectId}/${planHash.slice(0, 12)}`;
  const parent = fileURLToPath(
    new URL(`../.runtime/worktrees/${projectId}/`, import.meta.url),
  );
  const target = fileURLToPath(
    new URL(`../.runtime/worktrees/${projectId}/${planHash.slice(0, 24)}/`, import.meta.url),
  );
  t.after(async () => {
    await rm(parent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await execFileAsync("/usr/bin/git", ["-C", root, "init"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.name", "Test"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, "file.txt"), "old\n");
  await execFileAsync("/usr/bin/git", ["-C", root, "add", "file.txt"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "commit", "-m", "initial"]);
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-different",
    "+new",
    "",
  ].join("\n");
  const plan = {
    objective: "验证失败清理",
    planHash,
    steps: [
      { id: "补丁", capability: "code_patch" },
      { id: "分支", capability: "local_branch", inputs: { patchStepId: "补丁" } },
    ],
  };
  await assert.rejects(
    createControlledWorkAdapters({ codexPath: "/bin/false" })
      .local_branch.execute({
        plan,
        step: plan.steps[1],
        manifest: {
          version: 1,
          projectId,
          name: "失败清理测试",
          rootDirectory: root,
          requesters: ["user-1"],
          capabilities: { local_branch: { mode: "approval_required" } },
        },
        priorEvidence: {
          补丁: {
            kind: "unified_diff",
            content: patch,
            sha256: createHash("sha256").update(patch).digest("hex"),
          },
        },
      }),
  );
  await assert.rejects(access(target), { code: "ENOENT" });
  await assert.rejects(access(parent), { code: "ENOENT" });
  await assert.rejects(
    execFileAsync("/usr/bin/git", [
      "-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`,
    ]),
  );
});

test("代码补丁只应用到隔离分支且不覆盖原工作区", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-isolated-repo-"));
  const remote = await mkdtemp(join(tmpdir(), "ai-isolated-remote-"));
  const releaseState = join(root, "release-state.txt");
  const releaseScript = join(root, "release-tool");
  const projectId = `test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let evidence;
  t.after(async () => {
    if (evidence) {
      await execFileAsync("/usr/bin/git", [
        "-C", root, "worktree", "remove", "--force", evidence.worktreeDirectory,
      ]).catch(() => {});
      await execFileAsync("/usr/bin/git", [
        "-C", root, "branch", "-D", evidence.branch,
      ]).catch(() => {});
      await rmdir(dirname(evidence.worktreeDirectory)).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  await execFileAsync("/usr/bin/git", ["-C", remote, "init", "--bare"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "init"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.name", "Test"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, "file.txt"), "old\n");
  await execFileAsync("/usr/bin/git", ["-C", root, "add", "file.txt"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "commit", "-m", "initial"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "remote", "add", "origin", remote]);
  await writeFile(releaseState, "old\n");
  await writeFile(releaseScript, [
    "#!/bin/sh",
    "case \"$1\" in",
    `  deploy) printf 'new\\n' > '${releaseState}' ;;`,
    `  verify) /usr/bin/grep -Eq '^(old|new)$' '${releaseState}' ;;`,
    `  verify-old) /usr/bin/grep -Eq '^old$' '${releaseState}' ;;`,
    `  rollback) printf 'old\\n' > '${releaseState}' ;;`,
    "  *) exit 2 ;;",
    "esac",
  ].join("\n"), { mode: 0o700 });
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const plan = {
    planHash: createHash("sha256").update(projectId).digest("hex"),
    objective: "隔离修改",
    steps: [
      { id: "补丁", capability: "code_patch" },
      {
        id: "分支",
        capability: "local_branch",
        workingDirectory: root,
        inputs: { patchStepId: "补丁" },
      },
      {
        id: "测试",
        capability: "local_test",
        workingDirectory: root,
        inputs: { commandId: "内容检查", workspaceStepId: "分支" },
      },
      {
        id: "推送",
        capability: "git_push",
        workingDirectory: root,
        inputs: { workspaceStepId: "分支" },
      },
      {
        id: "发布",
        capability: "production_deploy",
        workingDirectory: root,
        inputs: {
          workspaceStepId: "分支",
          pushStepId: "推送",
          commandId: "生产发布",
          verificationCommandId: "发布验收",
          rollbackCommandId: "发布回滚",
        },
      },
    ],
  };
  const manifest = {
    version: 1,
    projectId,
    name: "隔离项目",
    rootDirectory: root,
    requesters: ["user-1"],
    capabilities: {
      code_patch: { mode: "automatic" },
      local_branch: { mode: "approval_required" },
      local_test: {
        mode: "approval_required",
        commands: {
          内容检查: {
            executable: "/usr/bin/grep",
            args: ["new", "file.txt"],
            timeoutMs: 10_000,
            maxOutputBytes: 10_000,
          },
        },
      },
      git_push: {
        mode: "approval_required",
        maxRuns: 1,
        timeoutMs: 30_000,
        remote: "origin",
        expectedRemoteUrl: remote,
        branchPrefix: "foursday/",
      },
      production_deploy: {
        mode: "approval_required",
        maxRuns: 1,
        commands: {
          生产发布: { executable: releaseScript, args: ["deploy"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
          发布验收: { executable: releaseScript, args: ["verify"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
          仅认旧版本: { executable: releaseScript, args: ["verify-old"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
          发布回滚: { executable: releaseScript, args: ["rollback"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
        },
      },
    },
  };
  const result = await createControlledWorkAdapters({ codexPath: "/bin/false" })
    .local_branch.execute({
      plan,
      step: plan.steps[1],
      manifest,
      priorEvidence: {
        补丁: {
          kind: "unified_diff",
          content: patch,
          sha256: createHash("sha256").update(patch).digest("hex"),
        },
      },
    });
  evidence = result.evidence;
  assert.equal(result.verified, true);
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(evidence.worktreeDirectory, "file.txt"), "utf8"), "new\n");
  const committed = await execFileAsync("/usr/bin/git", [
    "-C", evidence.worktreeDirectory, "show", "--format=", "--name-only", evidence.commit,
  ]);
  assert.equal(committed.stdout.trim(), "file.txt");
  const testResult = await createControlledWorkAdapters({ codexPath: "/bin/false" })
    .local_test.execute({
      plan,
      step: plan.steps[2],
      manifest,
      priorEvidence: { 分支: evidence },
    });
  assert.equal(testResult.evidence.exitCode, 0);
  assert.equal(testResult.evidence.outputStored, false);
  const adapters = createControlledWorkAdapters({ codexPath: "/bin/false" });
  await adapters.git_push.preflight({ plan, step: plan.steps[3], manifest });
  const pushResult = await adapters.git_push.execute({
    plan,
    step: plan.steps[3],
    manifest,
    priorEvidence: { 分支: evidence },
  });
  assert.equal(pushResult.evidence.commit, evidence.commit);
  const remoteCommit = await execFileAsync("/usr/bin/git", [
    "--git-dir", remote, "rev-parse", `refs/heads/${evidence.branch}`,
  ]);
  assert.equal(remoteCommit.stdout.trim(), evidence.commit);
  const deployResult = await adapters.production_deploy.execute({
    plan,
    step: plan.steps[4],
    manifest,
    priorEvidence: { 分支: evidence, 推送: pushResult.evidence },
  });
  assert.equal(deployResult.evidence.commit, evidence.commit);
  assert.equal(deployResult.evidence.rollbackExecuted, false);
  assert.equal(await readFile(releaseState, "utf8"), "new\n");

  const failingStep = structuredClone(plan.steps[4]);
  failingStep.inputs.verificationCommandId = "仅认旧版本";
  await assert.rejects(
    adapters.production_deploy.execute({
      plan,
      step: failingStep,
      manifest,
      priorEvidence: { 分支: evidence, 推送: pushResult.evidence },
    }),
    (error) => {
      assert.equal(error.executionEvidence.rollbackSucceeded, true);
      assert.equal(error.executionEvidence.recoveryVerified, true);
      return true;
    },
  );
  assert.equal(await readFile(releaseState, "utf8"), "old\n");
});

test("GitHub PR 草稿只基于已核验推送并逐字段回读", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-gh-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-gh");
  const argumentsPath = join(directory, "arguments.jsonl");
  const bodyRecord = join(directory, "body.md");
  const readbackPath = join(directory, "readback.json");
  const branch = "foursday/change-1";
  const commit = "a".repeat(40);
  const readback = {
    number: 42,
    url: "https://github.com/example/project/pull/42",
    state: "OPEN",
    isDraft: true,
    headRefName: branch,
    headRefOid: commit,
    headRepository: { nameWithOwner: "example/project" },
    baseRefName: "main",
    title: "修复问题",
    body: "变更与测试说明\n",
  };
  await writeFile(readbackPath, JSON.stringify(readback));
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "if (args[0] === 'pr' && args[1] === 'create') {",
    "  const bodyPath = args[args.indexOf('--body-file') + 1];",
    `  fs.writeFileSync(${JSON.stringify(bodyRecord)}, fs.readFileSync(bodyPath));`,
    "  console.log('https://github.com/example/project/pull/42');",
    "} else if (args[0] === 'pr' && args[1] === 'view') {",
    `  console.log(fs.readFileSync(${JSON.stringify(readbackPath)}, 'utf8'));`,
    "} else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const plan = {
    steps: [
      { id: "push", capability: "git_push" },
      {
        id: "pr", capability: "github_pr_draft",
        inputs: { pushStepId: "push", title: "修复问题", body: "变更与测试说明", baseBranch: "main" },
      },
    ],
  };
  const project = {
    version: 1, projectId: "test_project", name: "GitHub 项目",
    rootDirectory: directory, requesters: ["user-1"],
    capabilities: {
      git_push: {
        mode: "approval_required", remote: "origin",
        expectedRemoteUrl: "https://github.com/example/project.git",
        branchPrefix: "foursday/",
      },
      github_pr_draft: {
        mode: "approval_required", repository: "example/project",
        baseBranches: ["main"], maxTitleChars: 120, maxBodyBytes: 65_536,
      },
    },
  };
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false", ghPath: executable,
  }).github_pr_draft;
  await adapter.preflight({ plan, step: plan.steps[1], manifest: project });
  const execute = () => adapter.execute({
    plan,
    step: plan.steps[1],
    manifest: project,
    priorEvidence: {
      push: { kind: "verified_git_push", branch, commit },
    },
  });
  const result = await execute();
  assert.equal(result.evidence.kind, "verified_github_pr_draft");
  assert.equal(result.evidence.number, 42);
  assert.equal(result.evidence.state, "OPEN");
  assert.equal(result.evidence.isDraft, true);
  assert.equal(result.evidence.commit, commit);
  assert.equal(result.evidence.headRepository, "example/project");
  assert.equal(await readFile(bodyRecord, "utf8"), "变更与测试说明\n");
  const invocations = (await readFile(argumentsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].includes("--draft"), true);
  assert.match(invocations[1][invocations[1].indexOf("--json") + 1], /headRefOid/u);
  assert.match(invocations[1][invocations[1].indexOf("--json") + 1], /body/u);

  for (const mutation of [
    { number: 41 },
    { isDraft: false },
    { headRefOid: "b".repeat(40) },
    { body: "正文已被修改\n" },
  ]) {
    await writeFile(readbackPath, JSON.stringify({ ...readback, ...mutation }));
    await assert.rejects(
      execute(),
      /GitHub PR readback did not match the approved intent/u,
    );
  }

  const forkProject = structuredClone(project);
  forkProject.capabilities.git_push.expectedRemoteUrl =
    "https://github.com/tester/project.git";
  forkProject.capabilities.github_pr_draft.headRepository = "tester/project";
  await adapter.preflight({ plan, step: plan.steps[1], manifest: forkProject });
  await writeFile(readbackPath, JSON.stringify({
    ...readback,
    headRepository: { nameWithOwner: "tester/project" },
  }));
  const forkResult = await adapter.execute({
    plan,
    step: plan.steps[1],
    manifest: forkProject,
    priorEvidence: { push: { kind: "verified_git_push", branch, commit } },
  });
  assert.equal(forkResult.evidence.headRepository, "tester/project");
  const forkInvocations = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  const forkCreate = forkInvocations.at(-2);
  assert.equal(forkCreate[forkCreate.indexOf("--head") + 1], `tester:${branch}`);
});

test("共享文档只写固定目标并通过 DWS 回读哈希验收", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-shared-doc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const statePath = join(directory, "document.txt");
  const argumentsPath = join(directory, "arguments.jsonl");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "if (args[0] === 'doc' && args[1] === 'create') {",
    "  const file = args[args.indexOf('--content-file') + 1];",
    `  fs.writeFileSync(${JSON.stringify(statePath)}, fs.readFileSync(file, 'utf8'));`,
    "  console.log(JSON.stringify({result:{nodeId:'node-1',docUrl:'https://alidocs.invalid/i/nodes/node-1'}}));",
    "} else if (args[0] === 'doc' && args[1] === 'read') {",
    `  console.log(JSON.stringify({result:{content:fs.readFileSync(${JSON.stringify(statePath)},'utf8')}}));`,
    "} else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const plan = {
    objective: "发布方案文档",
    steps: [
      { id: "草稿", capability: "document_draft" },
      {
        id: "共享",
        capability: "shared_document_write",
        inputs: {
          documentStepId: "草稿",
          title: "项目方案",
          folderNodeId: "不允许覆盖固定目标",
        },
      },
    ],
  };
  const manifest = {
    version: 1,
    projectId: "doc_test",
    name: "文档测试",
    rootDirectory: directory,
    requesters: ["user-1"],
    capabilities: {
      document_draft: { mode: "automatic" },
      shared_document_write: {
        mode: "approval_required",
        folderNodeId: "fixed-folder-node",
        workspaceId: null,
        maxContentBytes: 200 * 1024,
        timeoutMs: 10_000,
      },
    },
  };
  const adapters = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  });
  await adapters.shared_document_write.preflight({
    plan,
    step: plan.steps[1],
    manifest,
  });
  const result = await adapters.shared_document_write.execute({
    plan,
    step: plan.steps[1],
    manifest,
    priorEvidence: {
      草稿: {
        kind: "document_markdown",
        content: "## 结论\n\n采用受控方案。\n",
      },
    },
  });
  assert.equal(result.evidence.verification, "dws_doc_readback_hash_matches");
  const calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf("--folder") + 1], "fixed-folder-node");
  assert.equal(calls[0].includes("不允许覆盖固定目标"), false);
  assert.deepEqual(calls[0].slice(-2), ["--format", "json"]);
  const contentPath = calls[0][calls[0].indexOf("--content-file") + 1];
  await assert.rejects(access(contentPath), { code: "ENOENT" });
});

test("待办和日程只使用清单固定人员并在创建后回读", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-office-actions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const argumentsPath = join(directory, "arguments.jsonl");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "if (args[0] === 'todo' && args[2] === 'create') console.log(JSON.stringify({result:{todoTaskId:'todo-1'}}));",
    "else if (args[0] === 'todo' && args[2] === 'get') console.log(JSON.stringify({result:{id:'todo-1',title:'完成评审',priority:'30',due:'2026-08-05T18:00:00+08:00',executorUserIds:['executor-1']}}));",
    "else if (args[0] === 'calendar' && args[2] === 'create') console.log(JSON.stringify({result:{eventId:'event-1'}}));",
    "else if (args[0] === 'calendar' && args[2] === 'get') console.log(JSON.stringify({result:{id:'event-1',summary:'项目评审',start:'2026-08-05T10:00:00+08:00',end:'2026-08-05T11:00:00+08:00',timezone:'Asia/Shanghai',freeBusy:'busy',attendeeUserIds:['attendee-1']}}));",
    "else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const manifest = {
    version: 1,
    projectId: "office_test",
    name: "办公能力测试",
    rootDirectory: directory,
    requesters: ["user-1"],
    capabilities: {
      dingtalk_todo_create: {
        mode: "approval_required",
        allowedExecutorUserIds: ["executor-1"],
        allowedPriorities: ["20", "30"],
        maxTitleChars: 120,
        timeoutMs: 10_000,
      },
      dingtalk_calendar_create: {
        mode: "approval_required",
        allowedAttendeeUserIds: ["attendee-1"],
        maxDurationMinutes: 120,
        maxTitleChars: 120,
        timeoutMs: 10_000,
      },
    },
  };
  const adapters = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  });
  const todoStep = {
    capability: "dingtalk_todo_create",
    inputs: {
      title: "完成评审",
      executorUserIds: ["executor-1"],
      priority: "30",
      due: "2026-08-05T18:00:00+08:00",
    },
  };
  await adapters.dingtalk_todo_create.preflight({ step: todoStep, manifest });
  const todo = await adapters.dingtalk_todo_create.execute({ step: todoStep, manifest });
  assert.equal(todo.evidence.verification, "dws_todo_get_succeeded");
  const calendarStep = {
    capability: "dingtalk_calendar_create",
    inputs: {
      title: "项目评审",
      start: "2026-08-05T10:00:00+08:00",
      end: "2026-08-05T11:00:00+08:00",
      attendeeUserIds: ["attendee-1"],
      timezone: "Asia/Shanghai",
    },
  };
  await adapters.dingtalk_calendar_create.preflight({
    step: calendarStep,
    manifest,
  });
  const calendar = await adapters.dingtalk_calendar_create.execute({
    step: calendarStep,
    manifest,
  });
  assert.equal(calendar.evidence.verification, "dws_calendar_get_succeeded");
  const calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.equal(calls[0][calls[0].indexOf("--executors") + 1], "executor-1");
  assert.equal(calls[2][calls[2].indexOf("--attendees") + 1], "attendee-1");
  assert.equal(calls.every((call) => call.includes("--yes") === false), true);
  assert.equal(calls.every((call) => call.slice(-2).join(" ") === "--format json"), true);
});

test("日程回读拒绝未申请的会议室和循环规则", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-calendar-extra-fields-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const statePath = join(directory, "mode.txt");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'calendar' && args[2] === 'create') console.log(JSON.stringify({result:{eventId:'event-extra'}}));",
    "else if (args[0] === 'calendar' && args[2] === 'get') {",
    `  const mode=fs.readFileSync(${JSON.stringify(statePath)},'utf8').trim();`,
    "  const extra=mode==='room'?{roomId:'unexpected-room'}:{recurrenceType:'weekly',recurrenceInterval:'1',recurrenceCount:'6',recurrenceDaysOfWeek:['tuesday']};",
    "  console.log(JSON.stringify({result:{id:'event-extra',summary:'项目评审',start:'2026-08-05T10:00:00+08:00',end:'2026-08-05T11:00:00+08:00',timezone:'Asia/Shanghai',freeBusy:'busy',attendeeUserIds:[],...extra}}));",
    "}",
    "else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const manifest = {
    capabilities: {
      dingtalk_calendar_create: {
        allowedAttendeeUserIds: [],
        allowedRoomNames: ["永澄亭"],
        allowRecurrence: true,
        allowedRecurrenceTypes: ["weekly"],
        maxRecurrenceCount: 10,
        maxDurationMinutes: 120,
        maxTitleChars: 120,
        timeoutMs: 10_000,
      },
    },
  };
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  }).dingtalk_calendar_create;
  const step = {
    capability: "dingtalk_calendar_create",
    inputs: {
      title: "项目评审",
      start: "2026-08-05T10:00:00+08:00",
      end: "2026-08-05T11:00:00+08:00",
      attendeeUserIds: [],
      timezone: "Asia/Shanghai",
    },
  };
  for (const mode of ["room", "recurrence"]) {
    await writeFile(statePath, mode);
    await assert.rejects(
      adapter.execute({ step, manifest }),
      /calendar readback did not match created event/u,
    );
  }
});

test("办公动作回读缺少获批字段时标记为需要人工对账", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-office-readback-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[2] === 'create') console.log(JSON.stringify({result:{todoTaskId:'todo-unknown'}}));",
    "else if (args[2] === 'get') console.log(JSON.stringify({result:{id:'todo-unknown',title:'完成评审'}}));",
    "else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  }).dingtalk_todo_create;
  await assert.rejects(
    adapter.execute({
      step: {
        capability: "dingtalk_todo_create",
        inputs: {
          title: "完成评审",
          executorUserIds: ["executor-1"],
          priority: "30",
        },
      },
      manifest: {
        capabilities: {
          dingtalk_todo_create: {
            allowedExecutorUserIds: ["executor-1"],
            allowedPriorities: ["30"],
            maxTitleChars: 120,
            timeoutMs: 10_000,
          },
        },
      },
    }),
    (error) => {
      assert.match(error.message, /readback did not match/u);
      assert.deepEqual(error.executionEvidence, {
        kind: "dingtalk_todo_readback_unknown",
        inputSha256: error.executionEvidence.inputSha256,
        taskId: "todo-unknown",
        verification: "external_side_effect_requires_reconciliation",
        reconciliationRequired: true,
        outputStored: false,
      });
      assert.match(error.executionEvidence.inputSha256, /^[a-f0-9]{64}$/u);
      return true;
    },
  );
});

test("日志提交核对固定模板结构、使用临时文件并在提交后回读", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-report-submit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const argumentsPath = join(directory, "arguments.jsonl");
  const contentsRecord = join(directory, "contents.json");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "if (args[0] === 'report' && args[1] === 'template' && args[2] === 'list') {",
    "  console.log(JSON.stringify({result:{items:[{report_template_id:'template-1',report_template_name:'项目日报'}]}}));",
    "} else if (args[0] === 'report' && args[1] === 'template' && args[2] === 'get') {",
    "  console.log(JSON.stringify({result:{report_template_fields:[{field_name:'今日完成',field_sort:0,field_type:1},{field_name:'明日计划',field_sort:1,field_type:1}]}}));",
    "} else if (args[0] === 'report' && args[1] === 'entry' && args[2] === 'submit') {",
    "  const file = args[args.indexOf('--contents-file') + 1];",
    `  fs.writeFileSync(${JSON.stringify(contentsRecord)}, fs.readFileSync(file));`,
    "  console.log(JSON.stringify({result:{reportId:'report-1'}}));",
    "} else if (args[0] === 'report' && args[1] === 'entry' && args[2] === 'get') {",
    "  console.log(JSON.stringify({result:{reportId:'report-1',report_template_id:'template-1',report_name:'项目日报',contents:[{key:'今日完成',content:'完成方案'},{key:'明日计划',content:'推进评审'}]}}));",
    "} else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const manifest = {
    version: 1,
    projectId: "report_test",
    name: "日志测试",
    rootDirectory: directory,
    requesters: ["user-1"],
    capabilities: {
      dingtalk_report_submit: {
        mode: "approval_required",
        templateId: "template-1",
        templateName: "项目日报",
        fields: [
          { name: "今日完成", sort: "0", type: "1" },
          { name: "明日计划", sort: "1", type: "1" },
        ],
        maxContentBytes: 10_000,
        timeoutMs: 10_000,
      },
    },
  };
  const step = {
    capability: "dingtalk_report_submit",
    inputs: {
      fieldValues: { 今日完成: "完成方案", 明日计划: "推进评审" },
    },
  };
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  }).dingtalk_report_submit;
  await adapter.preflight({ step, manifest });
  const result = await adapter.execute({ step, manifest });
  assert.equal(result.evidence.verification, "dws_report_get_succeeded");
  const contents = JSON.parse(await readFile(contentsRecord, "utf8"));
  assert.deepEqual(contents.map((field) => field.key), ["今日完成", "明日计划"]);
  assert.equal(contents.every((field) => field.contentType === "markdown"), true);
  const calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["report", "template", "list"],
    ["report", "template", "get"],
    ["report", "entry", "submit"],
    ["report", "entry", "get"],
  ]);
  assert.equal(calls.every((call) => call.slice(-2).join(" ") === "--format json"), true);
  const temporaryPath = calls[2][calls[2].indexOf("--contents-file") + 1];
  await assert.rejects(access(temporaryPath), { code: "ENOENT" });
});

test("日志模板在审批后漂移时拒绝提交", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-report-drift-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const argumentsPath = join(directory, "arguments.jsonl");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "if (args[2] === 'list') console.log(JSON.stringify({result:{items:[{report_template_id:'template-1',report_template_name:'项目日报'}]}}));",
    "else if (args[2] === 'get') console.log(JSON.stringify({result:{report_template_fields:[{field_name:'已修改字段',field_sort:0,field_type:1}]}}));",
    "else process.exit(9);",
  ].join("\n"), { mode: 0o700 });
  const manifest = {
    capabilities: {
      dingtalk_report_submit: {
        templateId: "template-1",
        templateName: "项目日报",
        fields: [{ name: "今日完成", sort: "0", type: "1" }],
        maxContentBytes: 10_000,
        timeoutMs: 10_000,
      },
    },
  };
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  }).dingtalk_report_submit;
  await assert.rejects(
    adapter.execute({
      step: {
        capability: "dingtalk_report_submit",
        inputs: { fieldValues: { 今日完成: "完成方案" } },
      },
      manifest,
    }),
    /template fields changed/u,
  );
  const calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
});

test("会议室 ID 只来自同一时段实时搜索且循环日程使用有界规则", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-calendar-room-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const argumentsPath = join(directory, "arguments.jsonl");
  const calendarStatePath = join(directory, "calendar-state.json");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "if (args[0] === 'calendar' && args[1] === 'room') console.log(JSON.stringify({result:{rooms:[{roomId:'real-room-id',roomName:'永澄亭'}]}}));",
    "else if (args[0] === 'calendar' && args[2] === 'create') {",
    `  fs.writeFileSync(${JSON.stringify(calendarStatePath)}, JSON.stringify({title:args[args.indexOf('--title')+1],roomId:args.includes('--rooms')?args[args.indexOf('--rooms')+1]:null,recurrenceType:args.includes('--recurrence-type')?args[args.indexOf('--recurrence-type')+1]:null,recurrenceInterval:args.includes('--recurrence-interval')?args[args.indexOf('--recurrence-interval')+1]:null,recurrenceCount:args.includes('--recurrence-count')?args[args.indexOf('--recurrence-count')+1]:null,recurrenceDaysOfWeek:args.includes('--recurrence-days-of-week')?args[args.indexOf('--recurrence-days-of-week')+1].split(','):[]}));`,
    "  console.log(JSON.stringify({result:{eventId:'event-room'}}));",
    "}",
    "else if (args[0] === 'calendar' && args[2] === 'get') {",
    `  const state=JSON.parse(fs.readFileSync(${JSON.stringify(calendarStatePath)},'utf8'));`,
    "  console.log(JSON.stringify({result:{eventId:'event-room',summary:state.title,start:'2026-08-05T10:00:00+08:00',end:'2026-08-05T11:00:00+08:00',timezone:'Asia/Shanghai',freeBusy:'busy',attendeeUserIds:[],...state}}));",
    "}",
    "else process.exit(2);",
  ].join("\n"), { mode: 0o700 });
  const manifest = {
    capabilities: {
      dingtalk_calendar_create: {
        allowedAttendeeUserIds: [],
        allowedRoomNames: ["永澄亭"],
        allowRecurrence: true,
        allowedRecurrenceTypes: ["daily", "weekly"],
        maxRecurrenceCount: 10,
        maxDurationMinutes: 120,
        maxTitleChars: 120,
        timeoutMs: 10_000,
      },
    },
  };
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  }).dingtalk_calendar_create;
  const roomStep = {
    capability: "dingtalk_calendar_create",
    inputs: {
      title: "项目评审",
      start: "2026-08-05T10:00:00+08:00",
      end: "2026-08-05T11:00:00+08:00",
      roomName: "永澄亭",
    },
  };
  const roomResult = await adapter.execute({ step: roomStep, manifest });
  assert.equal(
    roomResult.evidence.verification,
    "dws_room_search_then_calendar_get_succeeded",
  );
  let calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls[0].slice(0, 3).join(" "), "calendar room search");
  assert.equal(calls[1][calls[1].indexOf("--rooms") + 1], "real-room-id");
  await writeFile(argumentsPath, "");
  const recurrenceStep = {
    capability: "dingtalk_calendar_create",
    inputs: {
      title: "每周复盘",
      start: "2026-08-05T10:00:00+08:00",
      end: "2026-08-05T11:00:00+08:00",
      recurrence: {
        type: "weekly",
        interval: 1,
        count: 6,
        daysOfWeek: ["tuesday"],
      },
    },
  };
  await adapter.execute({ step: recurrenceStep, manifest });
  calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls[0][calls[0].indexOf("--recurrence-range-type") + 1], "numbered");
  assert.equal(calls[0][calls[0].indexOf("--recurrence-count") + 1], "6");
  assert.equal(calls[0].includes("--rooms"), false);
});

test("会议室搜索返回多项时停止且不创建日程", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-calendar-room-many-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-dws");
  const argumentsPath = join(directory, "arguments.jsonl");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args)+'\\n');`,
    "console.log(JSON.stringify({result:{rooms:[{roomId:'one'},{roomId:'two'}]}}));",
  ].join("\n"), { mode: 0o700 });
  const adapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    dwsPath: executable,
  }).dingtalk_calendar_create;
  await assert.rejects(adapter.execute({
    step: {
      capability: "dingtalk_calendar_create",
      inputs: {
        title: "项目评审",
        start: "2026-08-05T10:00:00+08:00",
        end: "2026-08-05T11:00:00+08:00",
        roomName: "永澄亭",
      },
    },
    manifest: {
      capabilities: {
        dingtalk_calendar_create: {
          allowedAttendeeUserIds: [],
          allowedRoomNames: ["永澄亭"],
          allowRecurrence: false,
          allowedRecurrenceTypes: [],
          maxRecurrenceCount: null,
          maxDurationMinutes: 120,
          maxTitleChars: 120,
          timeoutMs: 10_000,
        },
      },
    },
  }), /exactly one/u);
  const calls = (await readFile(argumentsPath, "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slice(0, 3).join(" "), "calendar room search");
});

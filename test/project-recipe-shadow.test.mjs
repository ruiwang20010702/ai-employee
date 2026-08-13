import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  confirmProjectRecipeShadowReview,
  previewProjectRecipeShadow,
  projectRecipeShadowReviewConfirmation,
  runProjectRecipeShadow,
} from "../src/project-recipe-shadow.mjs";
import { Store } from "../src/store.mjs";

const execFileAsync = promisify(execFile);
const recipesDirectory = new URL("../deploy/recipes/", import.meta.url);

async function fixture(t, { selectedRecipeIds = ["project-follow-up"] } = {}) {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), "foursday-project-shadow-")),
  );
  await mkdir(join(sandbox, "project"));
  const root = await realpath(join(sandbox, "project"));
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await writeFile(join(root, "README.md"), [
    "# Project",
    "The goal is to return one verified workday every week.",
  ].join("\n"));
  await execFileAsync("/usr/bin/git", ["-C", root, "add", "README.md"], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await execFileAsync("/usr/bin/git", [
    "-C", root,
    "-c", "user.name=Foursday Test",
    "-c", "user.email=foursday-test@example.invalid",
    "commit", "--quiet", "-m", "initial",
  ], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const bundle = {
    schema: "foursday-historical-project-import/v1",
    project: {
      projectId: "shadow_project",
      name: "影子验证项目",
      rootDirectory: root,
      requesterIds: ["owner-1"],
      profile: {
        objective: "验证项目配方交付物",
        successCriteria: ["形成可审阅证据"],
        milestones: ["完成影子验证"],
        collaborationObjects: ["repository"],
        selectedRecipeIds,
        memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 180 },
      },
    },
    sources: [{ id: "readme", path: "README.md" }],
    memories: [],
  };
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return { root, sandbox, bundle };
}

function artifactRuntime({ failAt = null } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generateArtifact({ prompt }) {
      calls += 1;
      if (calls === failAt) throw new Error("mock runtime failed");
      const output = calls === 1
        ? "# 研究结论\n\n- 已核对项目内 README。"
        : "# 跟进草稿\n\n- 下一步：由负责人审阅证据。";
      return {
        output,
        bytes: Buffer.byteLength(output),
        sha256: createHash("sha256").update(output).digest("hex"),
        promptSha256: createHash("sha256").update(prompt).digest("hex"),
      };
    },
  };
}

test("项目配方影子预览不写文件、不调用模型并仅允许已选择配方", async (t) => {
  const { root, bundle } = await fixture(t);
  const preview = await previewProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "首次证据化跟进" },
    recipesDirectory,
    now: new Date("2026-08-13T09:00:00.000Z"),
  });
  assert.equal(preview.schema, "foursday-project-recipe-shadow-preview/v1");
  assert.equal(preview.plan.steps.length, 2);
  assert.deepEqual(preview.plan.steps.map((step) => step.capability), [
    "research",
    "document_draft",
  ]);
  assert.equal(preview.modelInvoked, false);
  assert.equal(preview.databaseWrite, false);
  assert.equal(preview.authorityBoundary.productionDatabaseConnected, false);
  await assert.rejects(() => lstat(join(root, ".runtime")));
  await assert.rejects(
    () => previewProjectRecipeShadow({
      bundle,
      recipeId: "daily-report",
      values: { reportingPeriod: "today" },
      recipesDirectory,
    }),
    /was not selected/u,
  );
});

test("项目配方影子拒绝代码、记忆和外部副作用能力", async (t) => {
  const { bundle } = await fixture(t, { selectedRecipeIds: ["code-delivery"] });
  await assert.rejects(
    () => previewProjectRecipeShadow({
      bundle,
      recipeId: "code-delivery",
      values: {
        issueUrl: "https://github.com/example/repository/issues/1",
        changeRequest: "更新文档",
        testCommandId: "check",
        baseBranch: "main",
        prTitle: "docs: update",
      },
      recipesDirectory,
    }),
    /only permits research and document_draft/u,
  );
});

test("成功影子运行形成隔离账本、完整证据和待本人填写的时间返还", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const outputDirectory = join(sandbox, "shadow-output");
  const runtime = artifactRuntime();
  const result = await runProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "首次证据化跟进" },
    recipesDirectory,
    outputDirectory,
    artifactRuntime: runtime,
    now: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  assert.equal(result.status, "completed");
  assert.equal(runtime.calls, 2);
  assert.equal(result.timeReturnStatus, "awaiting_user_review_time");
  assert.equal(
    result.reviewConfirmation,
    projectRecipeShadowReviewConfirmation(result.evidenceSha256),
  );
  assert.equal(result.authorityBoundary.externalBusinessSystemsTouched, false);
  assert.equal(result.modelInvoked, true);
  const evidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
  assert.equal(evidence.steps.length, 2);
  assert.equal(evidence.steps.every((step) => step.status === "completed"), true);
  assert.match(evidence.steps[0].evidence.content, /研究结论/u);
  assert.equal(evidence.timeReturn.humanActiveMinutes, null);
  assert.equal(evidence.timeReturn.returnedMinutes, null);
  assert.equal(evidence.timeReturn.writtenToDatabase, false);
  const review = await readFile(result.reviewPath, "utf8");
  assert.match(review, /实际花了多少分钟/u);
  assert.match(review, /--human-minutes <实际分钟>/u);
  assert.match(review, new RegExp(result.reviewConfirmation, "u"));
  for (const path of [
    outputDirectory,
    result.evidencePath,
    result.reviewPath,
    join(outputDirectory, "影子证据.sqlite"),
    join(outputDirectory, "影子证据.sqlite.key"),
  ]) {
    const mode = (await lstat(path)).mode & 0o777;
    assert.equal(mode, path === outputDirectory ? 0o700 : 0o600);
  }
  const store = await new Store(join(outputDirectory, "影子证据.sqlite")).open();
  t.after(() => store.close());
  assert.equal(store.listWorkPlans({ status: "completed" }).length, 1);
  assert.equal(store.listTimeReturns({ projectId: "shadow_project" }).length, 0);
  assert.equal(store.listMemories({ projectId: "shadow_project" }).length, 0);
});

test("运行失败保留脱敏失败证据但不伪造成功或时间返还", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const outputDirectory = join(sandbox, "failed-output");
  await assert.rejects(
    () => runProjectRecipeShadow({
      bundle,
      recipeId: "project-follow-up",
      values: { projectFocus: "失败验证" },
      recipesDirectory,
      outputDirectory,
      artifactRuntime: artifactRuntime({ failAt: 1 }),
      now: () => new Date("2026-08-13T09:00:00.000Z"),
    }),
    /did not complete with verified evidence/u,
  );
  await assert.rejects(() => lstat(join(outputDirectory, "证据.json")));
  await assert.rejects(() => lstat(join(outputDirectory, "审阅说明.md")));
  const failure = JSON.parse(await readFile(join(outputDirectory, "失败证据.json"), "utf8"));
  assert.equal(failure.status, "failed");
  assert.equal(failure.errorCode, "operation_failed");
  assert.equal(failure.authorityBoundary.externalBusinessSystemsTouched, false);
  assert.equal(JSON.stringify(failure).includes("mock runtime failed"), false);
});

test("本人审阅确认绑定证据摘要且只更新隔离账本", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const outputDirectory = join(sandbox, "review-output");
  const run = await runProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "本人审阅确认" },
    recipesDirectory,
    outputDirectory,
    artifactRuntime: artifactRuntime(),
    now: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  const confirmation = projectRecipeShadowReviewConfirmation(run.evidenceSha256);
  const reviewed = await confirmProjectRecipeShadowReview({
    evidenceDirectory: outputDirectory,
    evidenceSha256: run.evidenceSha256,
    humanActiveMinutes: 10,
    confirmation,
    now: new Date("2026-08-13T10:00:00.000Z"),
  });
  assert.equal(reviewed.status, "confirmed");
  assert.equal(reviewed.returnedMinutes, reviewed.baselineMinutes - 10);
  assert.equal(reviewed.productionDatabaseConnected, false);
  assert.equal(reviewed.productionTimeReturnWrittenOrConfirmed, false);
  assert.equal((await lstat(reviewed.confirmationPath)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(reviewed.confirmationPath, "utf8"));
  assert.equal(record.evidenceSha256, run.evidenceSha256);
  assert.equal(record.localEvidenceLedgerUpdated, true);
  const store = await new Store(join(outputDirectory, "影子证据.sqlite")).open();
  t.after(() => store.close());
  const entries = store.listTimeReturns({ projectId: "shadow_project" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "confirmed");
  assert.equal(entries[0].humanActiveMinutes, 10);
  const repeated = await confirmProjectRecipeShadowReview({
    evidenceDirectory: outputDirectory,
    evidenceSha256: run.evidenceSha256,
    humanActiveMinutes: 10,
    confirmation,
    now: new Date("2026-08-13T11:00:00.000Z"),
  });
  assert.equal(repeated.returnedMinutes, reviewed.returnedMinutes);
  await assert.rejects(
    () => confirmProjectRecipeShadowReview({
      evidenceDirectory: outputDirectory,
      evidenceSha256: run.evidenceSha256,
      humanActiveMinutes: 11,
      confirmation,
    }),
    /does not match/u,
  );
});

test("本人审阅确认拒绝错误口令和被修改的证据", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const outputDirectory = join(sandbox, "tampered-review-output");
  const run = await runProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "篡改拒绝" },
    recipesDirectory,
    outputDirectory,
    artifactRuntime: artifactRuntime(),
    now: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  await assert.rejects(
    () => confirmProjectRecipeShadowReview({
      evidenceDirectory: outputDirectory,
      evidenceSha256: run.evidenceSha256,
      humanActiveMinutes: 10,
      confirmation: "REVIEW-WRONG",
    }),
    /requires confirmation/u,
  );
  await writeFile(run.evidencePath, `${await readFile(run.evidencePath, "utf8")}\n`);
  await assert.rejects(
    () => confirmProjectRecipeShadowReview({
      evidenceDirectory: outputDirectory,
      evidenceSha256: run.evidenceSha256,
      humanActiveMinutes: 10,
      confirmation: projectRecipeShadowReviewConfirmation(run.evidenceSha256),
    }),
    /SHA-256 does not match/u,
  );
  const store = await new Store(join(outputDirectory, "影子证据.sqlite")).open();
  t.after(() => store.close());
  assert.equal(store.listTimeReturns({ projectId: "shadow_project" }).length, 0);
});

test("本人审阅确认拒绝权限过宽的证据目录和文件", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const outputDirectory = join(sandbox, "wide-mode-review-output");
  const run = await runProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "权限边界" },
    recipesDirectory,
    outputDirectory,
    artifactRuntime: artifactRuntime(),
    now: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  const input = {
    evidenceDirectory: outputDirectory,
    evidenceSha256: run.evidenceSha256,
    humanActiveMinutes: 10,
    confirmation: projectRecipeShadowReviewConfirmation(run.evidenceSha256),
  };
  await chmod(outputDirectory, 0o755);
  await assert.rejects(
    () => confirmProjectRecipeShadowReview(input),
    /canonical regular directory/u,
  );
  await chmod(outputDirectory, 0o700);
  await chmod(run.evidencePath, 0o644);
  await assert.rejects(
    () => confirmProjectRecipeShadowReview(input),
    /protected regular file/u,
  );
  const store = await new Store(join(outputDirectory, "影子证据.sqlite")).open();
  t.after(() => store.close());
  assert.equal(store.listTimeReturns({ projectId: "shadow_project" }).length, 0);
});

test("冲突的预占本人确认文件不会先改变隔离账本", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const outputDirectory = join(sandbox, "occupied-review-output");
  const run = await runProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "确认文件预占" },
    recipesDirectory,
    outputDirectory,
    artifactRuntime: artifactRuntime(),
    now: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  await writeFile(join(outputDirectory, "本人确认.json"), `${JSON.stringify({
    schema: "foursday-project-recipe-shadow-review/v1",
    status: "confirmed",
    evidenceSha256: run.evidenceSha256,
    humanActiveMinutes: 9,
    productionDatabaseConnected: false,
    productionTimeReturnWrittenOrConfirmed: false,
  })}\n`, { mode: 0o600 });
  await assert.rejects(
    () => confirmProjectRecipeShadowReview({
      evidenceDirectory: outputDirectory,
      evidenceSha256: run.evidenceSha256,
      humanActiveMinutes: 10,
      confirmation: projectRecipeShadowReviewConfirmation(run.evidenceSha256),
    }),
    /does not match/u,
  );
  const store = await new Store(join(outputDirectory, "影子证据.sqlite")).open();
  t.after(() => store.close());
  assert.equal(store.listTimeReturns({ projectId: "shadow_project" }).length, 0);
});

test("影子运行绑定干净 Git 提交并拒绝运行期间来源漂移", async (t) => {
  const { root, sandbox, bundle } = await fixture(t);
  await writeFile(join(root, "dirty.txt"), "dirty\n");
  await assert.rejects(
    () => previewProjectRecipeShadow({
      bundle,
      recipeId: "project-follow-up",
      values: { projectFocus: "脏工作树" },
      recipesDirectory,
    }),
    /requires a clean Git worktree/u,
  );
  await rm(join(root, "dirty.txt"));
  let calls = 0;
  const changingRuntime = {
    async generateArtifact() {
      calls += 1;
      if (calls === 1) await writeFile(join(root, "README.md"), "# Changed during run\n");
      const output = `# Artifact ${calls}`;
      return {
        output,
        bytes: Buffer.byteLength(output),
        sha256: createHash("sha256").update(output).digest("hex"),
      };
    },
  };
  const outputDirectory = join(sandbox, "changed-output");
  await assert.rejects(
    () => runProjectRecipeShadow({
      bundle,
      recipeId: "project-follow-up",
      values: { projectFocus: "来源漂移" },
      recipesDirectory,
      outputDirectory,
      artifactRuntime: changingRuntime,
      now: () => new Date("2026-08-13T09:00:00.000Z"),
    }),
    /clean Git worktree|source snapshot changed/u,
  );
  await assert.rejects(() => lstat(join(outputDirectory, "证据.json")));
  const failure = JSON.parse(await readFile(join(outputDirectory, "失败证据.json"), "utf8"));
  assert.equal(failure.status, "failed");
});

test("影子 Git 核验禁用项目仓库配置的 fsmonitor 外部程序", async (t) => {
  const { root, sandbox, bundle } = await fixture(t);
  const sentinel = join(sandbox, "fsmonitor-invoked");
  const monitor = join(sandbox, "fsmonitor.sh");
  await writeFile(monitor, [
    "#!/bin/sh",
    `printf invoked > ${JSON.stringify(sentinel)}`,
    "printf 'token\\n'",
  ].join("\n"), { mode: 0o700 });
  await chmod(monitor, 0o700);
  await execFileAsync("/usr/bin/git", [
    "-C", root, "config", "core.fsmonitor", monitor,
  ], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  await execFileAsync("/usr/bin/git", [
    "-C", root, "status", "--porcelain=v1",
  ], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }).catch(() => {});
  assert.equal((await lstat(sentinel)).isFile(), true);
  await rm(sentinel);
  const preview = await previewProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "禁用 fsmonitor" },
    recipesDirectory,
  });
  assert.equal(preview.repository.clean, true);
  await assert.rejects(() => lstat(sentinel));
});

test("影子输出必须是不存在的规范绝对目录且拒绝符号链接父目录", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const existing = join(sandbox, "existing");
  await mkdir(existing);
  const input = {
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "路径验证" },
    recipesDirectory,
    artifactRuntime: artifactRuntime(),
  };
  await assert.rejects(
    () => runProjectRecipeShadow({ ...input, outputDirectory: existing }),
    /must not already exist/u,
  );
  await assert.rejects(
    () => runProjectRecipeShadow({ ...input, outputDirectory: "relative-output" }),
    /normalized absolute path/u,
  );
  const actual = join(sandbox, "actual-parent");
  await mkdir(actual);
  const linked = join(sandbox, "linked-parent");
  await symlink(actual, linked);
  await assert.rejects(
    () => runProjectRecipeShadow({
      ...input,
      outputDirectory: join(linked, "output"),
    }),
    /must not traverse a symbolic link/u,
  );
});

test("projects:shadow 命令默认只预览且不接受输出目录", async (t) => {
  const { sandbox, bundle } = await fixture(t);
  const bundlePath = join(sandbox, "bundle.json");
  const valuesPath = join(sandbox, "values.json");
  const outputDirectory = join(sandbox, "cli-output");
  await Promise.all([
    writeFile(bundlePath, `${JSON.stringify(bundle)}\n`, { mode: 0o600 }),
    writeFile(valuesPath, `${JSON.stringify({ projectFocus: "CLI 预览" })}\n`, { mode: 0o600 }),
  ]);
  await Promise.all([chmod(bundlePath, 0o600), chmod(valuesPath, 0o600)]);
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/运行项目配方影子验证.mjs",
    "--bundle", bundlePath,
    "--recipe", "project-follow-up",
    "--values", valuesPath,
  ], { cwd: new URL("../", import.meta.url) });
  const preview = JSON.parse(stdout);
  assert.equal(preview.modelInvoked, false);
  assert.equal(preview.databaseWrite, false);
  await assert.rejects(() => lstat(outputDirectory));
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      "scripts/运行项目配方影子验证.mjs",
      "--bundle", bundlePath,
      "--recipe", "project-follow-up",
      "--values", valuesPath,
      "--output", outputDirectory,
    ], { cwd: new URL("../", import.meta.url) }),
    /--output is only accepted with --run/u,
  );

  const run = await runProjectRecipeShadow({
    bundle,
    recipeId: "project-follow-up",
    values: { projectFocus: "CLI 审阅" },
    recipesDirectory,
    outputDirectory,
    artifactRuntime: artifactRuntime(),
    now: () => new Date("2026-08-13T09:00:00.000Z"),
  });
  const reviewed = await execFileAsync(process.execPath, [
    "scripts/运行项目配方影子验证.mjs",
    "--review", outputDirectory,
    "--evidence-sha256", run.evidenceSha256,
    "--human-minutes", "10",
    "--confirm", projectRecipeShadowReviewConfirmation(run.evidenceSha256),
  ], { cwd: new URL("../", import.meta.url) });
  const reviewResult = JSON.parse(reviewed.stdout);
  assert.equal(reviewResult.status, "confirmed");
  assert.equal(reviewResult.productionDatabaseConnected, false);
});

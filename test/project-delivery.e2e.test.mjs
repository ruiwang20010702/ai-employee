import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Store } from "../src/store.mjs";
import { createControlledWorkAdapters } from "../src/work-adapters.mjs";
import { executeWorkPlan } from "../src/work-executor.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

const execFileAsync = promisify(execFile);

test("项目交付从补丁到发布形成完整审批和证据闭环", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "ai-delivery-e2e-"));
  const root = join(sandbox, "project");
  const remote = join(sandbox, "remote.git");
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(remote, { recursive: true }),
  ]);
  const store = await new Store(join(sandbox, "store.sqlite")).open();
  let worktreeEvidence;
  t.after(async () => {
    if (worktreeEvidence) {
      await execFileAsync("/usr/bin/git", [
        "-C", root, "worktree", "remove", "--force",
        worktreeEvidence.worktreeDirectory,
      ]).catch(() => {});
      await execFileAsync("/usr/bin/git", [
        "-C", root, "branch", "-D", worktreeEvidence.branch,
      ]).catch(() => {});
      await rm(dirname(worktreeEvidence.worktreeDirectory), { recursive: false }).catch(() => {});
    }
    store.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  await execFileAsync("/usr/bin/git", ["-C", remote, "init", "--bare"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "init"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.name", "AI Employee Test"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "config", "user.email", "ai-test@example.invalid"]);
  await writeFile(join(root, "file.txt"), "old\n");
  await execFileAsync("/usr/bin/git", ["-C", root, "add", "file.txt"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "commit", "-m", "initial"]);
  await execFileAsync("/usr/bin/git", ["-C", root, "remote", "add", "origin", remote]);

  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const fakeCodex = join(sandbox, "fake-codex");
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "target=''",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = '--output-last-message' ]; then shift; target=\"$1\"; fi",
    "  shift",
    "done",
    "cat >/dev/null",
    `printf '%s' '${patch.replaceAll("'", "'\\''")}' > \"$target\"`,
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const releaseState = join(sandbox, "release-state.txt");
  const releaseTool = join(sandbox, "release-tool");
  await writeFile(releaseState, "old\n");
  await writeFile(releaseTool, [
    "#!/bin/sh",
    "case \"$1\" in",
    ` deploy) printf 'new\\n' > '${releaseState}' ;;`,
    ` verify) /usr/bin/grep -Eq '^new$' '${releaseState}' ;;`,
    ` rollback) printf 'old\\n' > '${releaseState}' ;;`,
    " *) exit 2 ;;",
    "esac",
  ].join("\n"), { mode: 0o700 });

  const manifest = {
    version: 1,
    projectId: "delivery_test",
    name: "项目交付测试",
    rootDirectory: root,
    requesters: ["owner-1"],
    capabilities: {
      code_patch: { mode: "approval_required", timeoutMs: 30_000 },
      local_branch: { mode: "approval_required", maxRuns: 1 },
      local_test: {
        mode: "approval_required",
        commands: {
          检查: {
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
        branchPrefix: "ai-employee/",
      },
      production_deploy: {
        mode: "approval_required",
        maxRuns: 1,
        commands: {
          发布: { executable: releaseTool, args: ["deploy"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
          验收: { executable: releaseTool, args: ["verify"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
          回滚: { executable: releaseTool, args: ["rollback"], timeoutMs: 10_000, maxOutputBytes: 10_000 },
        },
      },
    },
  };
  const planInput = {
    version: 1,
    projectId: "delivery_test",
    requesterId: "owner-1",
    objective: "完成隔离修改、测试、推送和发布",
    steps: [
      { id: "补丁", capability: "code_patch", description: "形成补丁", workingDirectory: root, expectedEvidence: "补丁" },
      { id: "分支", capability: "local_branch", description: "创建隔离提交", workingDirectory: root, expectedEvidence: "提交", rollback: "删除隔离分支", inputs: { patchStepId: "补丁" } },
      { id: "测试", capability: "local_test", description: "执行检查", workingDirectory: root, expectedEvidence: "退出码", rollback: "清理测试数据", inputs: { commandId: "检查", workspaceStepId: "分支" } },
      { id: "推送", capability: "git_push", description: "推送隔离分支", workingDirectory: root, expectedEvidence: "远端提交", rollback: "另行审批删除远端分支", inputs: { workspaceStepId: "分支" } },
      { id: "发布", capability: "production_deploy", description: "发布并验收", workingDirectory: root, expectedEvidence: "发布回执", rollback: "执行登记回滚命令", inputs: { workspaceStepId: "分支", pushStepId: "推送", commandId: "发布", verificationCommandId: "验收", rollbackCommandId: "回滚" } },
    ],
  };
  const assessment = assessWorkPlan({ plan: planInput, manifest });
  assert.equal(assessment.decision, "REQUIRE_APPROVAL");
  const registered = store.registerWorkPlan(assessment);
  store.decideWorkPlan(registered.id, {
    decision: "approved",
    actor: "owner-1",
    reason: "批准当前计划哈希对应的隔离交付",
  });
  const result = await executeWorkPlan({
    store,
    planId: registered.id,
    manifest,
    adapters: createControlledWorkAdapters({ codexPath: fakeCodex }),
  });
  assert.equal(result.status, "completed");
  const evidence = store.listWorkPlanSteps(registered.id);
  assert.deepEqual(
    evidence.map((step) => step.evidence.kind),
    [
      "unified_diff",
      "isolated_git_worktree",
      "controlled_command",
      "verified_git_push",
      "verified_production_deploy",
    ],
  );
  worktreeEvidence = evidence[1].evidence;
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "old\n");
  assert.equal(await readFile(releaseState, "utf8"), "new\n");
  assert.equal(evidence[3].evidence.commit, evidence[1].evidence.commit);
  assert.equal(evidence[4].evidence.commit, evidence[1].evidence.commit);
});

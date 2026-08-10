import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseCurrentRun,
  chooseReleaseRun,
  validateBranchRef,
  validateCommitSha,
  validateCompletedRun,
  verifyGitHubReleaseCommit,
} from "../src/github-ci-verifier.mjs";

const workflowIdentity = Object.freeze({
  "check.yml": { id: 101, name: "检查", path: ".github/workflows/check.yml", state: "active" },
  "security.yml": { id: 102, name: "安全扫描", path: ".github/workflows/security.yml", state: "active" },
});

function releaseGateRun(runs, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "api") {
      const file = args[1].split("/").at(-1);
      return JSON.stringify(workflowIdentity[file]);
    }
    return JSON.stringify(runs);
  };
}

test("GitHub 提交验证只接受安全分支名称", () => {
  assert.equal(validateBranchRef("main"), "main");
  assert.equal(validateBranchRef("codex/ci-fix"), "codex/ci-fix");
  for (const value of ["", "../main", "--help", "main//next", "main branch"]) {
    assert.throws(() => validateBranchRef(value), /分支名称不合法/u);
  }
});

test("生产发布只接受完整的 40 位小写提交 SHA", () => {
  const sha = "a".repeat(40);
  assert.equal(validateCommitSha(sha), sha);
  for (const value of [
    "main",
    "a".repeat(39),
    "A".repeat(40),
    `${sha}0`,
    ` ${sha}`,
  ]) {
    assert.throws(() => validateCommitSha(value), /完整的 40 位小写 SHA/u);
  }
});

test("GitHub 提交验证优先等待当前提交正在运行的工作流", () => {
  const sha = "a".repeat(40);
  const active = {
    databaseId: 2,
    name: "检查",
    headSha: sha,
    status: "in_progress",
    conclusion: "",
  };
  const successful = {
    databaseId: 1,
    name: "检查",
    headSha: sha,
    status: "completed",
    conclusion: "success",
  };
  assert.equal(chooseCurrentRun([successful, active], "检查", sha), active);
});

test("GitHub 提交验证拒绝用其他提交或失败结果冒充通过", () => {
  const sha = "b".repeat(40);
  const success = {
    databaseId: 42,
    name: "安全扫描",
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    url: "https://github.example/actions/runs/42",
  };
  assert.deepEqual(validateCompletedRun(success, sha, "安全扫描"), {
    name: "安全扫描",
    event: "workflow_dispatch",
    runId: 42,
    url: "https://github.example/actions/runs/42",
  });
  assert.throws(
    () => validateCompletedRun({ ...success, headSha: "c".repeat(40) }, sha, "安全扫描"),
    /提交不匹配/u,
  );
  assert.throws(
    () => validateCompletedRun({ ...success, conclusion: "failure" }, sha, "安全扫描"),
    /未成功/u,
  );
  assert.throws(
    () => chooseCurrentRun([{ ...success, conclusion: "failure" }], "安全扫描", sha),
    /已有失败工作流/u,
  );
});

test("生产发布门禁只读核对目标 SHA 的检查与安全扫描", () => {
  const sha = "d".repeat(40);
  const calls = [];
  const runs = ["检查", "安全扫描"].map((name, index) => ({
    databaseId: index + 10,
    name,
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "push",
    workflowDatabaseId: index + 101,
    url: `https://github.example/actions/runs/${index + 10}`,
    createdAt: `2026-08-10T08:00:0${index}Z`,
  }));
  const result = verifyGitHubReleaseCommit({
    cwd: "/repository",
    sha,
    run: releaseGateRun(runs, calls),
  });
  assert.equal(result.valid, true);
  assert.equal(result.headSha, sha);
  assert.deepEqual(result.workflows.map((workflow) => workflow.name), [
    "检查",
    "安全扫描",
  ]);
  assert.equal(calls.length, 3);
  const listCall = calls.find((call) => call.args[0] === "run");
  assert.equal(listCall.command, "gh");
  assert.deepEqual(listCall.args.slice(0, 4), [
    "run",
    "list",
    "--commit",
    sha,
  ]);
  assert.equal(listCall.args.includes("workflow"), false);
  assert.equal(listCall.args.includes("watch"), false);
});

test("生产发布门禁拒绝缺失、运行中或最新失败的云端检查", () => {
  const sha = "e".repeat(40);
  const success = (name, databaseId, createdAt) => ({
    databaseId,
    name,
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "push",
    workflowDatabaseId: name === "检查" ? 101 : 102,
    url: `https://github.example/actions/runs/${databaseId}`,
    createdAt,
  });
  assert.throws(
    () => verifyGitHubReleaseCommit({
      sha,
      run: releaseGateRun([success("检查", 1, "2026-08-10T08:00:00Z")]),
    }),
    /缺少目标提交的工作流结果：安全扫描/u,
  );
  assert.throws(
    () => verifyGitHubReleaseCommit({
      sha,
      run: releaseGateRun([
        success("检查", 1, "2026-08-10T08:00:00Z"),
        {
          ...success("安全扫描", 2, "2026-08-10T08:00:01Z"),
          status: "in_progress",
          conclusion: "",
        },
      ]),
    }),
    /工作流未成功：安全扫描/u,
  );
  const olderSuccess = success("安全扫描", 2, "2026-08-10T08:00:01Z");
  const newerFailure = {
    ...olderSuccess,
    databaseId: 3,
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-08-10T08:01:00Z",
  };
  assert.equal(
    chooseReleaseRun([olderSuccess, newerFailure], "安全扫描", sha),
    newerFailure,
  );
  assert.throws(
    () => verifyGitHubReleaseCommit({
      sha,
      run: releaseGateRun([
        success("检查", 1, "2026-08-10T08:00:00Z"),
        olderSuccess,
        newerFailure,
      ]),
    }),
    /工作流未成功：安全扫描/u,
  );
});

test("生产门禁拒绝同名伪工作流和非 push 触发结果", () => {
  const sha = "f".repeat(40);
  const valid = (name, workflowDatabaseId) => ({
    databaseId: workflowDatabaseId + 1_000,
    workflowDatabaseId,
    name,
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "push",
    url: "https://github.example/actions/runs/1",
    createdAt: "2026-08-10T08:00:00Z",
  });
  assert.throws(
    () => verifyGitHubReleaseCommit({
      sha,
      run: releaseGateRun([
        { ...valid("检查", 999), workflowDatabaseId: 999 },
        valid("安全扫描", 102),
      ]),
    }),
    /缺少目标提交的工作流结果：检查/u,
  );
  assert.throws(
    () => verifyGitHubReleaseCommit({
      sha,
      run: releaseGateRun([
        { ...valid("检查", 101), event: "pull_request_target" },
        valid("安全扫描", 102),
      ]),
    }),
    /缺少目标提交的工作流结果：检查/u,
  );
});

test("生产门禁忽略同一提交较新的定时扫描并保留 push 证据", () => {
  const sha = "1".repeat(40);
  const push = {
    databaseId: 1,
    workflowDatabaseId: 102,
    name: "安全扫描",
    headSha: sha,
    status: "completed",
    conclusion: "success",
    event: "push",
    url: "https://github.example/actions/runs/1",
    createdAt: "2026-08-01T08:00:00Z",
  };
  const schedule = {
    ...push,
    databaseId: 2,
    event: "schedule",
    createdAt: "2026-08-10T08:00:00Z",
  };
  assert.equal(
    chooseReleaseRun([push, schedule], "安全扫描", sha, 102, ["push"]),
    push,
  );
});

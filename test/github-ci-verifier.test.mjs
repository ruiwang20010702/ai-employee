import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseCurrentRun,
  validateBranchRef,
  validateCompletedRun,
} from "../src/github-ci-verifier.mjs";

test("GitHub 提交验证只接受安全分支名称", () => {
  assert.equal(validateBranchRef("main"), "main");
  assert.equal(validateBranchRef("codex/ci-fix"), "codex/ci-fix");
  for (const value of ["", "../main", "--help", "main//next", "main branch"]) {
    assert.throws(() => validateBranchRef(value), /分支名称不合法/u);
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

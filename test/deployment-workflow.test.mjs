import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/production-release.yml",
  import.meta.url,
);
const checkWorkflowUrl = new URL(
  "../.github/workflows/check.yml",
  import.meta.url,
);

test("生产发布使用稳定版本目录、外部密钥门禁和失败回退", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /AI_EMPLOYEE_DEPLOY_ROOT/u);
  assert.match(workflow, /AI_EMPLOYEE_RELEASE_DIRECTORY/u);
  assert.match(workflow, /准备版本化发布\.mjs"? prepare/u);
  assert.match(workflow, /准备版本化发布\.mjs"? activate/u);
  assert.match(workflow, /\.deployment-controller/u);
  assert.match(workflow, /\.release-source/u);
  assert.match(workflow, /验证发布回退目标\.mjs/u);
  assert.match(workflow, /archive --format=tar HEAD/u);
  assert.match(workflow, /merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/u);
  assert.match(workflow, /AI_EMPLOYEE_DEPLOY_SHA/u);
  assert.match(workflow, /Remote production config requires|macOS remote deployment requires/u);
  assert.match(workflow, /发布失败时恢复上一版本服务/u);
  assert.match(workflow, /AI_EMPLOYEE_SERVICE_SWITCH_ATTEMPTED/u);
  assert.equal(
    workflow.includes("${{ github.workspace }}/.runtime/production.json"),
    false,
  );
});

test("持续集成从真实发布包执行隔离复用验收", async () => {
  const workflow = await readFile(checkWorkflowUrl, "utf8");
  assert.match(workflow, /npm run reuse:verify/u);
});

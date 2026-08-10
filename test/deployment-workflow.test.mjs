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
const securityWorkflowUrl = new URL(
  "../.github/workflows/security.yml",
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
  assert.match(workflow, /\.deployment-controller\/deploy\/回退基线\.json/u);
  assert.match(
    workflow,
    /--github-env "\$GITHUB_ENV"\n\s+- name: 写入目标版本文件/u,
  );
  assert.match(workflow, /merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/u);
  assert.match(workflow, /AI_EMPLOYEE_DEPLOY_SHA/u);
  assert.match(workflow, /Remote production config requires|macOS remote deployment requires/u);
  assert.match(workflow, /发布失败时恢复上一版本服务/u);
  assert.equal(
    workflow.match(/清理版本外常驻服务\.mjs/gu)?.length,
    2,
  );
  assert.match(workflow, /AI_EMPLOYEE_SERVICE_SWITCH_ATTEMPTED/u);
  assert.equal(
    workflow.includes("${{ github.workspace }}/.runtime/production.json"),
    false,
  );
  const ordered = [
    "验证发布回退目标.mjs",
    "npm run db:backup",
    "npm run db:migrate",
    "npm run production:doctor",
    "npm run production:codex-probe",
    "AI_EMPLOYEE_SERVICE_SWITCH_ATTEMPTED=true",
    "npm run service:install",
    "npm run production:service-verify",
  ];
  let cursor = -1;
  for (const value of ordered) {
    const next = workflow.indexOf(value, cursor + 1);
    assert.notEqual(next, -1, `生产发布缺少步骤：${value}`);
    assert.ok(next > cursor, `生产发布步骤顺序错误：${value}`);
    cursor = next;
  }
});

test("持续集成从真实发布包执行隔离复用验收", async () => {
  const workflow = await readFile(checkWorkflowUrl, "utf8");
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /node-version: \[22, 24\]/u);
  assert.match(workflow, /npm run rollback:verify/u);
  assert.match(workflow, /npm run reuse:verify/u);
  const ordered = [
    "npm audit --audit-level=high",
    "npm run check",
    "npm run rollback:verify",
    "npm pack --dry-run",
    "npm run reuse:verify",
  ];
  let cursor = -1;
  for (const value of ordered) {
    const next = workflow.indexOf(value, cursor + 1);
    assert.notEqual(next, -1, `持续集成缺少步骤：${value}`);
    assert.ok(next > cursor, `持续集成步骤顺序错误：${value}`);
    cursor = next;
  }
});

test("供应链工作流扫描密钥并固定所有第三方动作提交", async () => {
  const workflows = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(checkWorkflowUrl, "utf8"),
    readFile(securityWorkflowUrl, "utf8"),
  ]);
  const security = workflows[2];
  assert.match(security, /gitleaks\/gitleaks-action@[a-f0-9]{40}/u);
  assert.match(security, /fetch-depth: 0/u);
  for (const workflow of workflows) {
    const actions = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/gu)];
    assert.ok(actions.length > 0);
    for (const [, reference] of actions) {
      assert.match(reference, /^[a-f0-9]{40}$/u);
    }
  }
});

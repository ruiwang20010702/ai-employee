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

test("GitHub 生产工作流只做云端门禁且不接触生产", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /\.deployment-controller/u);
  assert.match(workflow, /\.release-source/u);
  assert.match(workflow, /\.deployment-controller\/deploy\/回退基线\.json/u);
  assert.match(
    workflow,
    /merge-base --is-ancestor "\$AI_EMPLOYEE_TARGET_SHA" refs\/remotes\/origin\/main/u,
  );
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /working-directory: \.deployment-controller/u);
  for (const forbidden of [
    "environment: production",
    "secrets.AI_EMPLOYEE_CONFIG_JSON",
    "self-hosted",
    "db:migrate",
    "service:install",
    "AI_EMPLOYEE_DEPLOY_ROOT",
  ]) {
    assert.equal(workflow.includes(forbidden), false, `门禁工作流不得包含：${forbidden}`);
  }
});

test("生产审批前固定完整 SHA 并要求两项云端检查成功", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /sha:\n\s+description: 要发布的完整 40 位小写提交 SHA/u);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/u);
  assert.equal(/default:\s*main/u.test(workflow), false);
  assert.equal(workflow.includes("${{ inputs.ref }}"), false);
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /--release-sha "\$AI_EMPLOYEE_TARGET_SHA"/u);
  assert.match(workflow, /ref: \$\{\{ steps\.target\.outputs\.deploy_sha \}\}/u);
  assert.match(workflow, /生产执行仅允许在已登录的 macOS 用户会话/u);
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

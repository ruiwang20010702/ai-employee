import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function projectText(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function assertOrdered(text, values) {
  let cursor = -1;
  for (const value of values) {
    const next = text.indexOf(value, cursor + 1);
    assert.notEqual(next, -1, `文档缺少上线步骤：${value}`);
    assert.ok(next > cursor, `上线步骤顺序错误：${value}`);
    cursor = next;
  }
}

test("产品需求文档元信息版本与最新变更记录一致", async () => {
  const text = await projectText("docs/产品需求文档.md");
  const current = text.match(/\| 当前版本 \| (V\d+\.\d+) \|/u)?.[1];
  const versions = [...text.matchAll(/\| \d{4}-\d{2}-\d{2} \| (V\d+\.\d+) \|/gu)]
    .map((match) => match[1]);
  assert.ok(current);
  assert.equal(current, versions.at(-1));
});

test("首次部署文档统一使用安全上线顺序", async () => {
  const readme = await projectText("README.md");
  const readmeSection = readme.slice(
    readme.indexOf("## 首次部署"),
    readme.indexOf("## 日常操作"),
  );
  const operations = await projectText("docs/生产运维手册.md");
  const operationsSection = operations.slice(
    operations.indexOf("## 3. 上线流程"),
    operations.indexOf("## 4. GitHub 人工发布"),
  );
  const commands = [
    "npm run production:preflight",
    "npm run db:backup",
    "npm run db:migrate",
    "npm run production:doctor",
    "npm run production:codex-probe",
    "npm run service:install",
    "npm run production:service-verify",
    "npm run production:verify",
    "npm run shadow:verify",
  ];
  assertOrdered(readmeSection, commands);
  assertOrdered(operationsSection, commands);
});

test("正式文档文件名保持中文统一口径", async () => {
  const names = await readdir(new URL("../docs/", import.meta.url));
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.match(name, /^[\p{Script=Han}]+\.md$/u);
  }
});

test("技术部署与业务自动化放量的状态口径不互相冒充", async () => {
  const [matrix, acceptance, review] = await Promise.all([
    projectText("docs/完成度矩阵.md"),
    projectText("docs/验收报告.md"),
    projectText("docs/统一审查报告.md"),
  ]);
  assert.match(matrix, /V2\.2 技术版本已部署/u);
  assert.match(matrix, /技术发布完成，业务自动化尚未放量/u);
  assert.match(acceptance, /技术发布完成不等于业务自动化放量/u);
  assert.match(review, /技术版本已部署.+业务自动化尚未放量/u);
  for (const text of [matrix, acceptance, review]) {
    assert.doesNotMatch(text, /V2\.2[^\n|]*(?:尚未提交|尚未推送|尚未部署)/u);
  }
});

test("完成度矩阵明确区分目标能力、当前授权和已部署闭环", async () => {
  const [requirements, matrix] = await Promise.all([
    projectText("docs/产品需求文档.md"),
    projectText("docs/完成度矩阵.md"),
  ]);
  assert.match(requirements, /产品能力目标，不代表当前生产已经开放相应权限/u);
  assert.match(matrix, /当前生产授权项目为 0/u);
  assert.match(matrix, /已随第 017 号迁移部署生产/u);
  assert.match(matrix, /时间与次数门禁已部署生产/u);
  assert.match(matrix, /费用估算和实际费用核销尚未闭环/u);
  assert.doesNotMatch(matrix, /第 01[78] 号迁移尚未应用生产/u);
});

test("权威文档共享同一生产版本且不保留已部署能力的候选口径", async () => {
  const [readme, requirements, matrix, acceptance, review, technical, overview, operations] =
    await Promise.all([
      projectText("README.md"),
      projectText("docs/产品需求文档.md"),
      projectText("docs/完成度矩阵.md"),
      projectText("docs/验收报告.md"),
      projectText("docs/统一审查报告.md"),
      projectText("docs/技术设计文档.md"),
      projectText("docs/设计总览.md"),
      projectText("docs/生产运维手册.md"),
    ]);
  const version = requirements.match(/\| 当前版本 \| (V\d+\.\d+) \|/u)?.[1];
  const productionSha = acceptance.match(/当前生产精确绑定提交 `([0-9a-f]{40})`/u)?.[1];
  assert.ok(version);
  assert.ok(productionSha);
  assert.match(matrix, new RegExp(`${version} 技术版本已部署`, "u"));
  assert.match(review, new RegExp(`${version} 提交`, "u"));
  assert.ok(technical.includes(`当前生产提交为 \`${productionSha}\``));
  for (const text of [readme, matrix, acceptance, review, technical, overview, operations]) {
    assert.doesNotMatch(
      text,
      /(?:第 01[78] 号迁移|信息不足任务闭环|自动记忆候选)[^\n|]*(?:尚未应用生产|生产未发布|当前生产未发布)/u,
    );
    assert.doesNotMatch(text, /当前主机仍安装[^\n|]*0\.2\.0/u);
  }
});

test("新环境文档禁止把生成的生产密钥写入配置", async () => {
  const [readme, operations, requirements] = await Promise.all([
    projectText("README.md"),
    projectText("docs/生产运维手册.md"),
    projectText("docs/产品需求文档.md"),
  ]);
  for (const text of [readme, operations, requirements]) {
    assert.match(text, /钥匙串/u);
    assert.match(text, /不(?:保存|生成或保存|把生成的生产密钥写入配置)/u);
  }
  assert.match(readme, /secrets --apply/u);
  assert.match(operations, /secrets --apply/u);
});

test("公开仓库安装说明固定到已审核完整提交", async () => {
  const readme = await projectText("README.md");
  assert.match(
    readme,
    /github:ruiwang20010702\/ai-employee#REPLACE_WITH_APPROVED_FULL_SHA/u,
  );
  assert.match(readme, /完整 40 位提交编号/u);
  assert.doesNotMatch(readme, /npm install[^\n]+#main/u);
});

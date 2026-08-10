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

test("候选版与既有生产版本的状态口径不互相冒充", async () => {
  const matrix = await projectText("docs/完成度矩阵.md");
  assert.match(matrix, /既有生产技术版本已部署；V2\.0 候选版尚未部署/u);
  assert.doesNotMatch(matrix, /\| 生产放量 \| 新版已部署/u);
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

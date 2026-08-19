import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

async function projectText(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("README 中英文首页统一定位为个人记忆驱动的 Hermes 工作分身", async () => {
  const [english, chinese] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
  ]);
  assert.match(english, /personal-memory-driven work twin/u);
  assert.match(english, /Hermes Agent Loop/u);
  assert.match(chinese, /个人记忆驱动/u);
  assert.match(chinese, /Hermes Agent Loop/u);
  for (const text of [english, chinese]) {
    assert.match(text, /68,786/u);
    assert.match(text, /81,088/u);
    assert.match(text, /Gate 2/u);
    assert.doesNotMatch(text, /project_evidence_read/u);
    assert.doesNotMatch(text, /produced_questions/u);
  }
});

test("README 区分已发布 Hermes 候选与 active 生产切换", async () => {
  const [english, chinese] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
  ]);
  for (const text of [english, chinese]) {
    assert.match(text, /Hermes.*Gateway/u);
    assert.match(text, /shadow/iu);
    assert.match(text, /Gate 2/u);
    assert.doesNotMatch(text, /v0\.6\.0-rc\.1/u);
  }
  assert.match(english, /candidate evidence, not an active-runtime cutover/iu);
  assert.match(chinese, /候选证据，不是 active Runtime 切换/u);
});

test("README 提供默认零写的一键 Hermes 安装入口并保留三阶段恢复", async () => {
  const [english, chinese, manifest] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("package.json"),
  ]);
  for (const text of [english, chinese]) {
    assert.match(text, /hermes:setup/u);
    assert.match(text, /hermes:prepare/u);
    assert.match(text, /hermes:patch/u);
    assert.match(text, /hermes:install/u);
    assert.match(text, /\.runtime\/hermes-poc/u);
  }
  const packageJson = JSON.parse(manifest);
  assert.equal(packageJson.scripts["hermes:setup"], "node scripts/一键安装Hermes.mjs");
  assert.equal(packageJson.scripts["hermes:prepare"], "node scripts/准备Hermes候选.mjs");
  assert.equal(packageJson.scripts["hermes:patch"], "node scripts/准备Hermes补丁层.mjs");
  assert.equal(packageJson.scripts["hermes:install"], "node scripts/安装Hermes发行层.mjs");
});

test("PRD 以通用 Agent Loop 为个人默认而把旧治理降级为企业模式", async () => {
  const requirements = await projectText("docs/产品需求文档.md");
  assert.match(requirements, /V3\.0 Hermes 候选/u);
  assert.match(requirements, /个人记忆驱动的 AI 工作分身/u);
  assert.match(requirements, /默认个人模式/u);
  assert.match(requirements, /可选 Enterprise \/ Governed Mode/u);
  assert.match(requirements, /可信联系人提出普通可恢复工作后[^\n]*默认自主执行/u);
  assert.match(requirements, /不得为这个问题新增 `produced_questions`/u);
  assert.match(requirements, /当前 12 项均已通过/u);
});

test("PRD 覆盖真实事实、连续追问、项目工作和人工接管", async () => {
  const requirements = await projectText("docs/产品需求文档.md");
  for (const phrase of [
    "新项目事实问题",
    "连续追问",
    "文档、分析和代码工作",
    "人工接管",
    "81,088",
    "68,786",
  ]) assert.match(requirements, new RegExp(phrase, "u"));
  assert.match(requirements, /安静窗口 3 秒/u);
  assert.match(requirements, /总等待 ≤ 8 秒/u);
});

test("设计总览为文档角色和模块导航的唯一地图", async () => {
  const overview = await projectText("docs/设计总览.md");
  for (const role of ["产品宪法", "架构地图", "技术权威", "当前状态", "生产运维", "历史决策"]) {
    assert.match(overview, new RegExp(role, "u"));
  }
  for (const path of [
    "src/hermes-upstream.mjs",
    "src/hermes-dws-sidecar.mjs",
    "hermes/plugins/project_router/",
    "src/hermes-personal-memory-context.mjs",
    "hermes/plugins/foursday_boundary/",
  ]) assert.match(overview, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(overview, /同一事实只在一个权威文档维护/u);
});

test("状态矩阵维护 Gate 2、生产边界和删除区", async () => {
  const status = await projectText("docs/完成度矩阵.md");
  assert.match(status, /12 项 PoC 门槛全部通过/u);
  assert.match(status, /Hermes shadow Gateway 已在独立 Application Support/u);
  assert.match(status, /旧 Node\.js Runtime 仍是唯一发送者/u);
  assert.match(status, /businessReady=true/u);
  for (const removed of [
    "project_evidence_read",
    "produced_questions",
    "固定 JSON Pointer",
    "逐联系人项目 requester",
    "自研完整 Agent Loop",
    "独立 Foursday 长期知识库",
  ]) assert.match(status, new RegExp(removed, "u"));
  assert.match(status, /兼容保留区/u);
  assert.match(status, /Enterprise \/ Governed Mode/u);
});

test("技术设计绑定精确上游、三文件补丁和薄发行层", async () => {
  const [technical, lock, patchLock] = await Promise.all([
    projectText("docs/技术设计文档.md"),
    projectText("hermes/upstream.lock.json"),
    projectText("hermes/patches.lock.json"),
  ]);
  const upstream = JSON.parse(lock);
  const patches = JSON.parse(patchLock);
  assert.match(technical, new RegExp(upstream.release.replace(".", "\\."), "u"));
  assert.match(technical, new RegExp(upstream.version.replaceAll(".", "\\."), "u"));
  assert.match(technical, new RegExp(upstream.commit, "u"));
  assert.equal(patches.patches.length, 1);
  for (const file of ["gateway/session.py", "gateway/platforms/base.py", "gateway/run.py"]) {
    assert.match(technical, new RegExp(file.replace(/[./]/g, "\\$&"), "u"));
  }
  assert.match(technical, /--no-allow-tool-override/u);
});

test("技术设计覆盖 DWS 个人身份、发送未知、接管和恢复", async () => {
  const technical = await projectText("docs/技术设计文档.md");
  for (const phrase of [
    "OpenDingTalk ID 类型显式传递",
    "3 秒安静窗口",
    "最近 5,000 个消息 ID",
    "outcomeUnknown=true",
    "human_takeover",
    "interrupt_session_activity",
    "撤回事件",
  ]) assert.match(technical, new RegExp(phrase, "u"));
});

test("技术设计覆盖常驻 shadow 与单写者切换门禁", async () => {
  const technical = await projectText("docs/技术设计文档.md");
  for (const phrase of [
    "Application Support",
    "Node supervisor",
    "send=false",
    "src/hermes-cutover.mjs",
    "先停 Hermes",
  ]) assert.match(technical, new RegExp(phrase, "u"));
});

test("技术设计明确个人 gbrain 唯一权威且凭据不进入 Agent", async () => {
  const [technical, memory] = await Promise.all([
    projectText("docs/技术设计文档.md"),
    projectText("docs/能力清单与正式记忆.md"),
  ]);
  for (const text of [technical, memory]) {
    assert.match(text, /个人 PRIVATE gbrain Git/u);
    assert.match(text, /唯一.*权威/u);
    assert.match(text, /default \+ read-only/u);
    assert.match(text, /Hermes Session DB/u);
    assert.doesNotMatch(text, /独立 Foursday 长期知识库[^\n]*当前默认/u);
  }
});

test("技术设计和能力文档把高风险控制放在程序边界", async () => {
  const [technical, capability] = await Promise.all([
    projectText("docs/技术设计文档.md"),
    projectText("docs/能力清单与正式记忆.md"),
  ]);
  for (const text of [technical, capability]) {
    assert.match(text, /Git push/u);
    assert.match(text, /生产部署/u);
    assert.match(text, /付款/u);
    assert.match(text, /合同/u);
    assert.match(text, /人事/u);
    assert.match(text, /秘密/u);
    assert.match(text, /失败关闭|fail.*closed/iu);
  }
  assert.match(technical, /终端无网络/u);
  assert.match(technical, /\.runtime/u);
});

test("Gate 2 报告十二项门槛全部通过且不冒充生产健康", async () => {
  const report = await projectText("docs/自主工作分身迁移验收报告.md");
  const rows = report.split("\n").filter((line) => /^\| \d+ \|/u.test(line));
  assert.equal(rows.length, 12);
  assert.ok(rows.every((line) => line.split("|").at(-2).trim() === "通过"));
  assert.match(report, /Gate 2 就绪/u);
  assert.match(report, /871 通过、0 失败/u);
  assert.match(report, /202 通过、1 条条件跳过/u);
  assert.match(report, /\/ready.*503/u);
  assert.match(report, /提交、推送仍需负责人另行授权/u);
});

test("旧运维、验收、审查和图 ADR 都标明兼容范围", async () => {
  const documents = await Promise.all([
    projectText("docs/生产运维手册.md"),
    projectText("docs/验收报告.md"),
    projectText("docs/统一审查报告.md"),
    projectText("docs/架构决策受治理工作图存储.md"),
    projectText("docs/en/deployment.md"),
    projectText("docs/en/adr-001-governed-work-graph-storage.md"),
  ]);
  assert.match(documents[0], /旧 Node\.js Governed Runtime/u);
  assert.match(documents[1], /历史\/兼容快照/u);
  assert.match(documents[2], /历史\/兼容审查/u);
  assert.match(documents[3], /Enterprise \/ Governed Mode/u);
  assert.match(documents[4], /legacy Node\.js governed production/iu);
  assert.match(documents[5], /optional Enterprise \/ Governed Mode/iu);
});

test("英文核心文档同步 V3 产品、架构、能力和部署边界", async () => {
  const [readme, overview, requirements, architecture, capability, deployment] =
    await Promise.all([
      projectText("README.md"),
      projectText("docs/en/overview.md"),
      projectText("docs/en/product-requirements.md"),
      projectText("docs/en/architecture.md"),
      projectText("docs/en/capabilities.md"),
      projectText("docs/en/deployment.md"),
    ]);
  assert.match(readme, /personal-memory-driven work twin/u);
  assert.match(overview, /Canonical owners/u);
  assert.match(requirements, /general Agent Loop/u);
  assert.match(architecture, /thin distribution/u);
  assert.match(capability, /Personal default/u);
  assert.match(deployment, /legacy Node\.js governed production/iu);
});

test("中英文 README 和核心文档的本地链接全部存在", async () => {
  const files = [
    "README.md",
    "README_ZH.md",
    "docs/设计总览.md",
    "docs/产品需求文档.md",
    "docs/技术设计文档.md",
    "docs/完成度矩阵.md",
    "docs/en/overview.md",
    "docs/en/product-requirements.md",
    "docs/en/architecture.md",
    "docs/en/capabilities.md",
  ];
  for (const file of files) {
    const text = await projectText(file);
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1].split("#")[0];
      if (!target || /^(?:https?:|mailto:)/u.test(target)) continue;
      await access(new URL(target, new URL(`../${file}`, import.meta.url)));
    }
  }
});

test("docs 根目录继续使用中文文件名", async () => {
  const entries = await readdir(new URL("../docs/", import.meta.url), {
    withFileTypes: true,
  });
  for (const entry of entries.filter((item) => item.isFile())) {
    assert.match(entry.name, /^[\p{Script=Han}]+\.md$/u);
  }
  assert.ok(entries.some((entry) => entry.isDirectory() && entry.name === "en"));
});

test("核心文档使用 Mermaid 展示产品和技术主流程", async () => {
  for (const file of [
    "README.md",
    "README_ZH.md",
    "docs/产品需求文档.md",
    "docs/设计总览.md",
    "docs/技术设计文档.md",
    "docs/en/architecture.md",
  ]) {
    assert.match(await projectText(file), /```mermaid/u);
  }
});

test("公开社交预览资源保持 GitHub 推荐尺寸", async () => {
  const asset = new URL("../assets/foursday-social-preview.png", import.meta.url);
  const [image, metadata] = await Promise.all([readFile(asset), stat(asset)]);
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(image.readUInt32BE(16), 1280);
  assert.equal(image.readUInt32BE(20), 640);
  assert.ok(metadata.size < 1024 * 1024);
});

test("公开文档不包含常见真实密钥格式", async () => {
  const files = [
    "README.md", "README_ZH.md", "docs/产品需求文档.md",
    "docs/设计总览.md", "docs/技术设计文档.md", "docs/完成度矩阵.md",
    "docs/自主工作分身架构迁移方案.md", "docs/自主工作分身迁移验收报告.md",
  ];
  const secret = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/u;
  for (const file of files) assert.doesNotMatch(await projectText(file), secret);
});

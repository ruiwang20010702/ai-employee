import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
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
  const readme = await projectText("README_ZH.md");
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
    "npm run production:agent-probe",
    "npm run service:install",
    "npm run production:service-verify",
    "npm run production:verify",
    "npm run shadow:verify",
  ];
  assertOrdered(readmeSection, commands);
  assertOrdered(operationsSection, commands);
});

test("中文权威文档在 docs 根目录保持中文统一口径", async () => {
  const entries = await readdir(new URL("../docs/", import.meta.url), {
    withFileTypes: true,
  });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.match(name, /^[\p{Script=Han}]+\.md$/u);
  }
  assert.ok(entries.some((entry) => entry.isDirectory() && entry.name === "en"));
});

test("技术部署与业务自动化放量的状态口径不互相冒充", async () => {
  const [matrix, acceptance, review] = await Promise.all([
    projectText("docs/完成度矩阵.md"),
    projectText("docs/验收报告.md"),
    projectText("docs/统一审查报告.md"),
  ]);
  assert.match(matrix, /V2\.4 技术版本[^\n]*已部署/u);
  assert.match(matrix, /业务自动化尚未放量/u);
  assert.match(acceptance, /技术发布完成不等于业务自动化放量/u);
  assert.match(review, /V2\.4 发布后补充[^\n]*仍未放量/u);
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
  assert.match(matrix, /当前生产已有 1 个 Foursday 项目/u);
  assert.match(matrix, /已随第 017 号迁移部署生产/u);
  assert.match(matrix, /时间与次数门禁已部署生产/u);
  assert.match(matrix, /费用估算和实际费用核销尚未闭环/u);
  assert.doesNotMatch(matrix, /第 01[78] 号迁移尚未应用生产/u);
});

test("项目配方影子入口在中英文文档中保持默认零写与显式运行边界", async () => {
  const [readme, readmeZh, capabilities, capabilitiesZh] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/capabilities.md"),
    projectText("docs/能力清单与正式记忆.md"),
  ]);
  for (const text of [readme, readmeZh, capabilities, capabilitiesZh]) {
    assert.match(text, /npm run projects:shadow/u);
    assert.match(text, /--run/u);
    assert.match(text, /--review/u);
  }
  assert.match(readme, /zero-write preview/iu);
  assert.match(readme, /model service/u);
  assert.match(readmeZh, /默认零写/u);
  assert.match(readmeZh, /模型服务/u);
});

test("权威文档区分当前技术部署与业务放量状态", async () => {
  const [readme, requirements, matrix, acceptance, review, technical, overview, operations] =
    await Promise.all([
      projectText("README_ZH.md"),
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
  assert.equal(version, "V2.4");
  assert.match(matrix, /V2\.4 技术版本[^\n]*已部署/u);
  assert.doesNotMatch(matrix, /V2\.4[^\n|]*(?:尚未提交|尚未推送|尚未部署)/u);
  assert.match(matrix, /业务自动化尚未放量/u);
  assert.match(review, /V2\.4 发布后补充/u);
  assert.ok(technical.includes(`当前生产提交为 \`${productionSha}\``));
  for (const text of [readme, matrix, acceptance, review, technical, overview, operations]) {
    assert.doesNotMatch(
      text,
      /(?:第 01[78] 号迁移|信息不足任务闭环|自动记忆候选)[^\n|]*(?:尚未应用生产|生产未发布|当前生产未发布)/u,
    );
    assert.doesNotMatch(text, /当前主机仍安装[^\n|]*0\.2\.0/u);
  }
  for (const text of [matrix, acceptance, review, technical, overview, operations]) {
    assert.doesNotMatch(
      text,
      /V2\.3(?:(?!V2\.4|。|\n|\|).)*(?:尚未提交|尚未推送|尚未部署)/u,
    );
  }
});

test("V2.3 个人工作闭环和社区扩展在中英文文档统一", async () => {
  const [readme, chinese, requirements, overview, architecture, integrations, capabilities, deployment] =
    await Promise.all([
      projectText("README.md"),
      projectText("README_ZH.md"),
      projectText("docs/产品需求文档.md"),
      projectText("docs/en/overview.md"),
      projectText("docs/en/architecture.md"),
      projectText("docs/en/integrations.md"),
      projectText("docs/en/capabilities.md"),
      projectText("docs/en/deployment.md"),
    ]);
  for (const value of ["Project onboarding", "Recipe library", "Project cockpit", "Time-return dashboard", "Proactive mode"]) {
    assert.match(readme, new RegExp(value, "u"));
  }
  assert.match(readme, /weekly delegation queue/u);
  for (const value of ["项目接入向导", "工作配方库", "项目驾驶舱", "时间返还仪表盘", "主动工作模式"]) {
    assert.match(chinese, new RegExp(value, "u"));
  }
  assert.match(chinese, /本周工作返还队列/u);
  assert.match(chinese, /AI 交付后的真实审阅\/修改耗时/u);
  assert.match(requirements, /未验证配方只标记为验证候选，不计入覆盖量/u);
  assert.match(overview, /evidence-ranked weekly delegation queue/u);
  for (const value of ["## 6.10", "## 6.11", "## 6.12", "## 6.13", "## 6.14", "## 6.15"]) {
    assert.ok(requirements.includes(value));
  }
  for (const text of [readme, chinese, requirements, overview, integrations, deployment]) {
    assert.match(text, /Slack/u);
    assert.match(text, /Teams/u);
    assert.match(text, /Gmail/u);
    assert.match(text, /Google Workspace/u);
  }
  assert.match(architecture, /WorkTrigger/u);
  assert.match(capabilities, /Draft PR/u);
  assert.match(deployment, /deployed-code rollout boundary/u);
});

test("Graph Engineering 生产实现把领域权威、图解释和业务权限明确区分", async () => {
  const [readme, chinese, architecture, overview, adr, chineseAdr] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/architecture.md"),
    projectText("docs/设计总览.md"),
    projectText("docs/en/adr-001-governed-work-graph-storage.md"),
    projectText("docs/架构决策受治理工作图存储.md"),
  ]);
  for (const value of ["Governed Work Graph", "Work graph", "Knowledge graph", "Governance graph"]) {
    assert.match(readme, new RegExp(value, "u"));
    assert.match(architecture, new RegExp(value, "u"));
  }
  for (const value of ["受治理工作图", "工作图", "知识图", "治理图"]) {
    assert.match(chinese, new RegExp(value, "u"));
    assert.match(overview, new RegExp(value, "u"));
  }
  assert.match(readme, /does not add a graph database or grant\s+production authority/u);
  assert.match(chinese, /不代表已经引入图数据库，也不代表项目、配方或主动工作已经获得生产权限/u);
  assert.match(architecture, /intended graph.+runtime graph/su);
  assert.match(overview, /Loop 是执行单元，Graph 是控制平面/u);
  for (const edge of [
    "project.has_authorization",
    "project.selects_recipe",
    "recipe.instantiates_plan",
    "authorization.grants_capability",
    "approval.authorizes_plan",
    "step.produces_evidence",
    "source.supports_memory",
    "memory.informs_plan",
    "plan.proposes_memory",
  ]) {
    assert.match(architecture, new RegExp(edge.replace(".", "\\."), "u"));
    assert.match(overview, new RegExp(edge.replace(".", "\\."), "u"));
  }
  for (const phrase of [
    "Current-state audit",
    "Graph Contract v1",
    "Invariants and forbidden shortcuts",
    "Required bounded queries",
    "Delivery stages and exit criteria",
  ]) {
    assert.match(architecture, new RegExp(phrase, "u"));
  }
  for (const phrase of [
    "现状审计",
    "Graph Contract v1",
    "不可突破的图约束",
    "第一批有界查询",
    "阶段和退出条件",
  ]) {
    assert.match(overview, new RegExp(phrase, "u"));
  }
  assert.match(architecture, /Graph\s+reachability is never authorization/u);
  assert.match(overview, /“图上可达”永远不等于“获得授权”/u);
  assert.match(architecture, /edgeId.+Deterministic hash/u);
  assert.match(overview, /edgeId.+确定性生成/u);
  assert.match(architecture, /Stages 1–4 are deployed in production commit/u);
  assert.match(overview, /Stage 1—4 已随生产提交/u);
  assert.match(architecture, /terminal capture failures are replayed by the executor/u);
  assert.match(overview, /终态采集失败由执行器自动补齐/u);
  assert.match(readme, /\[x\] Governed Work Graph v1 production implementation/u);
  assert.match(chinese, /\[x\] 受治理工作图 V1 生产实现/u);
  assert.match(readme, /Four bounded graph explanations/u);
  assert.match(chinese, /四类项目驾驶舱图解释/u);
  assert.match(adr, /Keep the Governed Work Graph in transactional stores/u);
  assert.match(adr, /22\.114 ms P95, and 26\.918 ms maximum/u);
  assert.match(chineseAdr, /受治理工作图继续使用事务数据库/u);
  assert.match(chineseAdr, /P95 为 22\.114 ms/u);
  for (const text of [readme, chinese, architecture, overview]) {
    assert.doesNotMatch(text, /(?:图数据库|graph database).{0,30}(?:已实现|已交付|implemented|shipped capability)/iu);
  }
});

test("新环境文档禁止把生成的生产密钥写入配置", async () => {
  const [readme, operations, requirements] = await Promise.all([
    projectText("README_ZH.md"),
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
  const [readme, chinese] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
  ]);
  for (const text of [readme, chinese]) {
    assert.match(
      text,
      /github:ruiwang20010702\/foursday#REPLACE_WITH_APPROVED_FULL_SHA/u,
    );
    assert.doesNotMatch(text, /npm install[^\n]+#main/u);
  }
  assert.match(readme, /reviewed 40-character commit SHA/u);
  assert.match(chinese, /完整 40 位提交编号/u);
});

test("中英文快速开始提供不可变的一条命令 Web 体验入口", async () => {
  const [readme, chinese] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
  ]);
  const immutableStart =
    /npx --yes --ignore-scripts --package "github:ruiwang20010702\/foursday#([a-f0-9]{40})" foursday start --pilot-sha \1/u;
  for (const text of [readme, chinese]) {
    assert.match(text, immutableStart);
    assert.match(text, /Node\.js 22 (?:or|或) 24/u);
  }
  assert.match(readme, /does not install a production service/u);
  assert.match(readme, /touch an external system at startup/u);
  assert.match(readme, /Prepare my pilot fork/u);
  assert.match(readme, /second\s+approval bound to the complete plan hash/u);
  assert.match(chinese, /不安装生产服务/u);
  assert.match(chinese, /不触碰外部系统/u);
  assert.match(chinese, /Prepare my pilot fork/u);
  assert.match(chinese, /再次批准完整计划哈希/u);
});

test("公开安装验收使用隔离无凭据环境且不冒充外部用户", async () => {
  const [pilot, chinesePilot, scorecard, chineseScorecard] = await Promise.all([
    projectText("docs/en/pilot-validation.md"),
    projectText("docs/体验验证说明.md"),
    projectText("docs/en/growth-scorecard.md"),
    projectText("docs/公开增长记分卡.md"),
  ]);
  for (const text of [pilot, scorecard]) {
    assert.match(text, /public-install:verify/u);
    assert.match(text, /credential token/u);
    assert.match(text, /does not count as an external tester|do not count/u);
  }
  for (const text of [chinesePilot, chineseScorecard]) {
    assert.match(text, /public-install:verify/u);
    assert.match(text, /不转发.*令牌|转发凭据令牌 0/u);
    assert.match(text, /不能冒充外部用户|外部用户.*不计数/u);
  }
});

test("外部体验入口为每位体验者使用唯一合成 Issue", async () => {
  const [readme, chinese, contract, chineseContract] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/pilot-validation.md"),
    projectText("docs/体验验证说明.md"),
  ]);
  for (const text of [readme, contract]) {
    assert.match(text, /Create your unique\s+pilot task/u);
    assert.match(text, /Issue #49.+(?:intake|claim|optional intent).+feedback/su);
    assert.match(text, /unique Issue/u);
  }
  for (const text of [chinese, chineseContract]) {
    assert.match(text, /Create your unique pilot task/u);
    assert.match(text, /Issue #49.+只用于.+反馈/su);
    assert.match(text, /唯一 Issue/u);
  }
  assert.doesNotMatch(contract, /Use public pilot Issue #49 and base branch/u);
  assert.doesNotMatch(chineseContract, /随后使用公开体验 Issue #49/u);
  assert.match(contract, /tester-maintainer/u);
  assert.match(contract, /every launch-cohort target passes/u);
  assert.match(chineseContract, /tester-maintainer/u);
  assert.match(chineseContract, /任何一条不一致/u);
});

test("公开增长记分卡不把重复自测和社区意向冒充用户或贡献", async () => {
  const [readme, chineseReadme, scorecard, chineseScorecard] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/growth-scorecard.md"),
    projectText("docs/公开增长记分卡.md"),
  ]);
  assert.match(readme, /Public growth scorecard/u);
  assert.match(chineseReadme, /公开增长记分卡/u);
  for (const text of [scorecard, chineseScorecard]) {
    for (const target of ["200", "50", "10", "5", "1,000"]) {
      assert.match(text, new RegExp(target, "u"));
    }
    assert.match(text, /10\/10/u);
    assert.match(text, /0\/10/u);
    assert.match(text, /PR #51/u);
    assert.match(text, /Issue #49/u);
    assert.match(text, /Issue #50/u);
  }
  assert.match(scorecard, /ten loops by one person still count as one user/u);
  assert.match(scorecard, /Claim comments.+are not completed contributors/su);
  assert.match(scorecard, /does not phone home/u);
  assert.match(chineseScorecard, /同一个人的 10 次闭环仍只算 1 人/u);
  assert.match(chineseScorecard, /认领留言.+不能提前记为完成/su);
  assert.match(chineseScorecard, /不会主动回传数据/u);
  assert.match(scorecard, /public candidate[\s\S]+10\/10 candidate-bound[\s\S]+maintainer loops/u);
  assert.match(chineseScorecard, /当前公开候选[\s\S]+10\/10 次候选绑定维护者闭环/u);
  assert.match(readme, /Report a successful install.+issues\/50/u);
  assert.match(chineseReadme, /报告一次成功安装.+issues\/50/u);
});

test("社交预览候选图满足 GitHub 推荐尺寸且不冒充已经上传", async () => {
  const assetUrl = new URL("../assets/foursday-social-preview.png", import.meta.url);
  const [image, metadata, english, chinese] = await Promise.all([
    readFile(assetUrl),
    stat(assetUrl),
    projectText("docs/en/growth-scorecard.md"),
    projectText("docs/公开增长记分卡.md"),
  ]);
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(image.readUInt32BE(16), 1280);
  assert.equal(image.readUInt32BE(20), 640);
  assert.ok(metadata.size < 1024 * 1024);
  assert.match(english, /separate public metadata change.+not implied/su);
  assert.match(chinese, /独立的公开元数据变更.+不能.+声称已经上传/su);
});

test("五分钟演示和三类扩展契约在中英文入口保持一致", async () => {
  const [
    readme,
    chinese,
    overview,
    architecture,
    integrations,
    packageJson,
    feishuSource,
  ] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/overview.md"),
    projectText("docs/en/architecture.md"),
    projectText("docs/en/integrations.md"),
    projectText("package.json"),
    projectText("src/feishu.mjs"),
  ]);
  for (const text of [readme, chinese, overview]) {
    assert.match(text, /npm run demo/u);
  }
  for (const text of [readme, chinese, architecture]) {
    assert.match(text, /MessageAdapter/u);
    assert.match(text, /AgentRuntime/u);
    assert.match(text, /ModelProvider/u);
  }
  assert.match(architecture, /Feishu adapter.+no DWS dependency/su);
  assert.match(integrations, /Feishu.+Official WebSocket.+No/su);
  assert.doesNotMatch(feishuSource, /from ["'][^"']*dws\.mjs["']/u);
  const manifest = JSON.parse(packageJson);
  assert.equal(manifest.scripts.demo, "node scripts/交互式演示.mjs");
  assert.equal(manifest.dependencies["@larksuiteoapi/node-sdk"], "1.73.0");
});

test("核心流程图覆盖业务、状态、执行、记忆和发布异常分支", async () => {
  const [requirements, technical, memory, operations, overview] = await Promise.all([
    projectText("docs/产品需求文档.md"),
    projectText("docs/技术设计文档.md"),
    projectText("docs/能力清单与正式记忆.md"),
    projectText("docs/生产运维手册.md"),
    projectText("docs/设计总览.md"),
  ]);
  for (const text of [requirements, technical, memory, operations, overview]) {
    assert.match(text, /```mermaid/u);
  }
  for (const value of [
    "是否在联系人或群聊范围内",
    "期限内唯一关联的补充消息",
    "禁止自动重试副作用",
  ]) assert.match(requirements, new RegExp(value, "u"));
  for (const value of [
    "stateDiagram-v2",
    "send_unknown",
    "sequenceDiagram",
    "副作用账本和验证证据",
  ]) assert.match(technical, new RegExp(value, "u"));
  for (const value of [
    "唯一匹配请求人有权使用的项目",
    "凭据、PII、敏感评价或越权内容检查",
    "负责人明确选择替代旧记忆",
    "检索时仍满足项目、来源、权限和期限吗",
  ]) assert.match(memory, new RegExp(value, "u"));
  for (const value of [
    "018 前滚边界",
    "写入 pending journal",
    "失败且不能安全回退",
    "另行申请业务放量审批",
  ]) assert.match(operations, new RegExp(value, "u"));
});

test("中英文项目首页提供产品定位、快速开始和双语开源治理入口", async () => {
  const [
    english,
    chinese,
    contributing,
    contributingChinese,
    security,
    conduct,
    conductChinese,
    changelog,
    changelogChinese,
    license,
  ] =
    await Promise.all([
      projectText("README.md"),
      projectText("README_ZH.md"),
      projectText("CONTRIBUTING.md"),
      projectText("CONTRIBUTING_ZH.md"),
      projectText("SECURITY.md"),
      projectText("CODE_OF_CONDUCT.md"),
      projectText("CODE_OF_CONDUCT_ZH.md"),
      projectText("CHANGELOG.md"),
      projectText("CHANGELOG_ZH.md"),
      projectText("LICENSE"),
    ]);
  for (const text of [english, chinese]) {
    assert.match(text, /assets\/foursday-hero\.svg/u);
    assert.match(text, /actions\/workflows\/check\.yml\/badge\.svg/u);
    assert.match(text, /npm run check/u);
    assert.match(text, /SECURITY\.md/u);
  }
  assert.match(english, /CONTRIBUTING\.md/u);
  assert.match(english, /CODE_OF_CONDUCT\.md/u);
  assert.match(chinese, /CONTRIBUTING_ZH\.md/u);
  assert.match(chinese, /CODE_OF_CONDUCT_ZH\.md/u);
  assert.match(english, /Why Foursday\?/u);
  assert.match(english, /Quick Start/u);
  assert.match(english, /简体中文.*README_ZH\.md/u);
  assert.match(chinese, /为什么做 Foursday/u);
  assert.match(chinese, /与普通机器人的区别/u);
  assert.match(chinese, /English.*README\.md/u);
  assert.match(contributing, /denied path/u);
  assert.match(contributingChinese, /拒绝路径/u);
  assert.match(security, /GitHub Security Advisory/u);
  assert.match(conduct, /Respect privacy/u);
  assert.match(conductChinese, /尊重隐私/u);
  assert.match(changelog, /\[0\.3\.0\] - 2026-08-11/u);
  assert.match(changelogChinese, /\[0\.3\.0\] - 2026-08-11/u);
  assert.match(license, /MIT License/u);
});

test("版本口径区分公开预览版与尚未发布的开发版本", async () => {
  const [english, chinese, changelog, changelogChinese, packageText] =
    await Promise.all([
      projectText("README.md"),
      projectText("README_ZH.md"),
      projectText("CHANGELOG.md"),
      projectText("CHANGELOG_ZH.md"),
      projectText("package.json"),
    ]);
  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.version, "0.6.0");
  assert.equal(packageJson.private, true);
  assert.match(english, /latest tagged public preview.+v0\.5\.0-rc\.1/su);
  assert.match(english, /v0\.6\.0, unreleased/u);
  assert.match(chinese, /最新带标签的公开预览版/u);
  assert.match(chinese, /尚未公开发布的 v0\.6\.0 开发版本/u);
  assert.match(changelog, /Target package version: `0\.6\.0`/u);
  assert.match(changelogChinese, /目标包版本为 `0\.6\.0`/u);
  for (const value of [changelog, changelogChinese]) {
    assert.doesNotMatch(value, /^## \[0\.6\.0\] - /mu);
    assert.match(value, /compare\/v0\.5\.0-rc\.1\.\.\.HEAD/u);
    assert.match(value, /releases\/tag\/v0\.5\.0-rc\.1/u);
  }
});

test("中英文首页、治理文件和英文核心文档的本地链接全部存在", async () => {
  for (const file of [
    "README.md",
    "README_ZH.md",
    "CONTRIBUTING.md",
    "CONTRIBUTING_ZH.md",
    "CODE_OF_CONDUCT.md",
    "CODE_OF_CONDUCT_ZH.md",
    "CHANGELOG.md",
    "CHANGELOG_ZH.md",
    "SECURITY.md",
    "docs/en/overview.md",
    "docs/en/product-requirements.md",
    "docs/en/architecture.md",
    "docs/en/capabilities.md",
    "docs/en/deployment.md",
    "docs/en/demo.md",
    "docs/en/first-contributions.md",
    "docs/en/pilot-validation.md",
    "docs/en/public-launch-playbook.md",
    "docs/真实演示录制说明.md",
    "docs/首次贡献任务.md",
    "docs/体验验证说明.md",
    "docs/公开发布手册.md",
  ]) {
    const text = await projectText(file);
    const base = new URL(`../${file}`, import.meta.url);
    const targets = [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
      .map((match) => match[1])
      .filter((target) => target.startsWith("."))
      .map((target) => target.split("#", 1)[0]);
    for (const target of new Set(targets)) {
      await assert.doesNotReject(
        access(new URL(target, base)),
        `${file} 的本地链接不存在：${target}`,
      );
    }
  }
});

test("公开发布手册区分定向体验、公开候选和大范围发布", async () => {
  const [readme, chineseReadme, english, chinese] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/public-launch-playbook.md"),
    projectText("docs/公开发布手册.md"),
  ]);
  assert.match(readme, /public-launch-playbook\.md/u);
  assert.match(chineseReadme, /公开发布手册\.md/u);
  for (const value of [english, chinese]) {
    assert.match(value, /10\/10/u);
    assert.match(value, /0\/10/u);
    assert.match(value, /Issue #49/u);
    assert.match(value, /Issue #50/u);
    assert.match(value, /1280 × 640/u);
    assert.match(value, /Show HN:/u);
    assert.match(value, /Draft PR/u);
  }
  assert.match(english, /Current-candidate maintainer loops \| 10\/10/u);
  assert.match(english, /Issues #54–#58, #60–#63, and #75/u);
  assert.match(english, /P95 and maximum 584\.7 seconds/u);
  assert.match(chinese, /当前候选维护者闭环 \| 10\/10/u);
  assert.match(chinese, /Issue #54–#58、#60–#63、#75/u);
  assert.match(chinese, /P95 与最大值 584\.7 秒/u);
  assert.match(english, /do not paste AI-generated or AI-edited copy/u);
  assert.match(english, /never request votes/u);
  assert.match(english, /ten distinct external loops/u);
  assert.match(chinese, /不能粘贴 AI 生成或 AI 修改/u);
  assert.match(chinese, /绝不索要投票/u);
  assert.match(chinese, /10 位不同外部体验者/u);
  assert.match(english, /Foursday never posts it/u);
  assert.match(chinese, /Foursday 不会自动发帖/u);
  const preReleaseUrl =
    "https://github.com/ruiwang20010702/foursday/releases/tag/v0.5.0-rc.1";
  for (const value of [readme, chineseReadme]) {
    assert.ok(value.includes(preReleaseUrl));
    assert.match(value, /e272f92dcebd10abbc599f32fed3e7db4428f9b7/u);
  }
  assert.match(english, /Immutable pre-release \| `v0\.5\.0-rc\.1`/u);
  assert.match(english, /10\/10 external loops.+promoted to a stable v0\.5 release/su);
  assert.match(chinese, /不可变预发布版 \| `v0\.5\.0-rc\.1`/u);
  assert.match(chinese, /外部 10\/10.+晋升为稳定 v0\.5 Release/su);
  for (const value of [english, chinese]) {
    assert.match(value, /npm run growth:report -- --sha/u);
    assert.match(value, /--pilot-manifest/u);
    assert.match(value, /--closed-loop-manifest/u);
    assert.match(value, /--extension-manifest/u);
    assert.match(value, /extensions:evidence:verify/u);
    assert.match(value, /pilot:self:verify/u);
    assert.match(value, /locallyVerifiedClosedLoopUsers/u);
    assert.match(value, /locallyVerifiedCommunityRecipesOrAdapters/u);
    assert.match(value, /onlineVerifiedPilotTargets/u);
  }
});

test("首批贡献任务已公开、范围受限且进入复用安装包", async () => {
  const [english, chinese, packageText, entries] = await Promise.all([
    projectText("docs/en/first-contributions.md"),
    projectText("docs/首次贡献任务.md"),
    projectText("package.json"),
    readdir(new URL("../.github/ISSUE_DRAFTS/", import.meta.url)),
  ]);
  const drafts = entries.filter((entry) => /^gfi-\d{3}-.+\.md$/u.test(entry)).sort();
  assert.equal(drafts.length, 5);
  assert.deepEqual(
    drafts.map((entry) => entry.slice(0, 7)),
    ["gfi-001", "gfi-002", "gfi-003", "gfi-004", "gfi-005"],
  );
  for (const draft of drafts) {
    const text = await projectText(`.github/ISSUE_DRAFTS/${draft}`);
    assert.match(text, /Labels: .*`good first issue`/u);
    assert.match(text, /## User outcome/u);
    assert.match(text, /## Scope/u);
    assert.match(text, /## Acceptance/u);
    assert.match(text, /## Non-goals/u);
    assert.doesNotMatch(text, /(?:enable|开启).{0,30}(?:production sending|生产发送)/iu);
    assert.match(english, new RegExp(draft.replace(".", "\\."), "u"));
  }
  for (const issueNumber of [3, 4, 5, 6, 7]) {
    const issueUrl = `https://github.com/ruiwang20010702/foursday/issues/${issueNumber}`;
    assert.match(english, new RegExp(issueUrl, "u"));
    assert.match(chinese, new RegExp(issueUrl, "u"));
  }
  assert.match(english, /All five tasks are live/u);
  assert.match(chinese, /5 个任务都已经开放/u);
  assert.doesNotMatch(english, /do not claim they are already open Issues/u);
  assert.doesNotMatch(chinese, /不宣称任务已经开放领取/u);
  assert.ok(JSON.parse(packageText).files.includes(".github/ISSUE_DRAFTS/"));
});

test("真实演示来自同一次闭环并保留外部复现边界", async () => {
  const [readme, chineseReadme, demo, chineseDemo, packageText, manifestText] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/demo.md"),
    projectText("docs/真实演示录制说明.md"),
    projectText("package.json"),
    projectText("assets/foursday-v0.5-demo.manifest.json"),
  ]);
  assert.match(readme, /Watch the 75-second demo/u);
  assert.match(readme, /Issue #29/u);
  assert.match(readme, /Draft PR #39/u);
  assert.match(chineseReadme, /观看 75 秒真实演示/u);
  assert.match(chineseReadme, /Issue #29/u);
  assert.match(chineseReadme, /Draft PR #39/u);
  for (const value of [
    "public, synthetic GitHub Issue",
    "complete plan hash",
    "verified Draft PR",
    "memory: proposed → confirmed",
    "No merge. No deploy.",
  ]) assert.match(demo, new RegExp(value, "u"));
  assert.match(demo, /does not prove external reproducibility/u);
  assert.match(demo, /ten independent testers/u);
  assert.match(demo, /verified_closed_loop/u);
  assert.match(demo, /integrity digest/u);
  assert.match(demo, /npm run demo:verify/u);
  assert.match(demo, /does not claim automated OCR/u);
  assert.match(demo, /\/workspace\/foursday/u);
  assert.match(chineseDemo, /不能把本地预览、无关 PR 和模拟结果剪接/u);
  assert.match(chineseDemo, /不代表外部可复现性已经验收/u);
  assert.match(chineseDemo, /10 位独立测试者/u);
  assert.match(chineseDemo, /verified_closed_loop/u);
  assert.match(chineseDemo, /不声称能够自动 OCR/u);
  assert.match(chineseDemo, /\/workspace\/foursday/u);
  const packageJson = JSON.parse(packageText);
  const manifest = JSON.parse(manifestText);
  assert.equal(packageJson.scripts["demo:verify"], "node scripts/验证公开演示.mjs");
  assert.equal(manifest.media.durationSeconds, 75);
  assert.equal(manifest.privacyReview.localAbsolutePathsShown, false);
  assert.equal(manifest.publicEvidence.merged, false);
  assert.equal(manifest.publicEvidence.deployed, false);
});

test("外部体验入口使用 fork 推送并把来源与上游目标纳入审批证据", async () => {
  const [readme, chineseReadme, pilot, chinesePilot] = await Promise.all([
    projectText("README.md"),
    projectText("README_ZH.md"),
    projectText("docs/en/pilot-validation.md"),
    projectText("docs/体验验证说明.md"),
  ]);
  for (const value of [readme, pilot]) {
    assert.match(value, /gh repo fork ruiwang20010702\/foursday|fork as the push source/u);
    assert.match(value, /upstream/u);
    assert.match(value, /git fetch upstream main|base branch `main`/u);
    assert.match(value, /Issue #49/u);
    assert.match(value, /do not need to wait for a\s+maintainer|No maintainer assignment is\s+required/u);
  }
  assert.match(pilot, /"candidateSha"/u);
  assert.match(pilot, /pilot:verify -- --manifest .* --sha/u);
  assert.match(chinesePilot, /candidateSha/u);
  assert.match(chinesePilot, /pilot:verify -- --manifest .* --sha/u);
  for (const value of [chineseReadme, chinesePilot]) {
    assert.match(value, /fork/u);
    assert.match(value, /upstream/u);
    assert.match(value, /来源/u);
    assert.match(value, /Draft/u);
    assert.match(value, /不再要求等待维护者分配名额|不再要求等待维护者分配/u);
  }
  assert.match(readme, /never merge or deploy/u);
  assert.match(chineseReadme, /禁止合并或部署/u);
  for (const value of [readme, pilot]) {
    assert.match(value, /privacy-safe pilot proof/u);
    assert.match(value, /unsigned/u);
    assert.match(value, /maintainer (?:target )?read-back/u);
    assert.match(value, /Copy privacy-safe readiness report/u);
    assert.match(value, /never submits it/u);
    assert.match(value, /paths, usernames|executable paths, usernames/u);
  }
  for (const value of [chineseReadme, chinesePilot]) {
    assert.match(value, /隐私安全体验证明/u);
    assert.match(value, /未签名/u);
    assert.match(value, /独立回读/u);
    assert.match(value, /Copy privacy-safe readiness report/u);
    assert.match(value, /不会自动提交/u);
    assert.match(value, /路径、用户名|可执行文件路径、用户名/u);
  }
});

test("十分钟接入证据区分服务侧自动计时与首次包下载", async () => {
  const [readme, chineseReadme, pilot, chinesePilot, scorecard, chineseScorecard] =
    await Promise.all([
      projectText("README.md"),
      projectText("README_ZH.md"),
      projectText("docs/en/pilot-validation.md"),
      projectText("docs/体验验证说明.md"),
      projectText("docs/en/growth-scorecard.md"),
      projectText("docs/公开增长记分卡.md"),
    ]);
  for (const value of [readme, pilot, scorecard]) {
    assert.match(value, /server-start-to-confirmed/u);
    assert.match(value, /monotonic/u);
    assert.match(value, /package download/u);
  }
  for (const value of [chineseReadme, chinesePilot, chineseScorecard]) {
    assert.match(value, /服务启动/u);
    assert.match(value, /单调时钟/u);
    assert.match(value, /包下载/u);
    assert.match(value, /不能.*单独|不能拿.*冒充/u);
  }
});

test("英文核心文档覆盖产品、架构、能力记忆和部署边界", async () => {
  const [readme, overview, architecture, capabilities, deployment] = await Promise.all([
    projectText("README.md"),
    projectText("docs/en/overview.md"),
    projectText("docs/en/architecture.md"),
    projectText("docs/en/capabilities.md"),
    projectText("docs/en/deployment.md"),
  ]);
  for (const path of ["overview", "architecture", "capabilities", "deployment"]) {
    assert.match(readme, new RegExp(`docs/en/${path}\\.md`, "u"));
  }
  for (const value of ["Default deny", "What it is not", "Implemented capability does not mean enabled capability"]) {
    assert.match(overview, new RegExp(value, "u"));
  }
  for (const value of ["stateDiagram-v2", "Side-effect reliability", "Business ready"]) {
    assert.match(architecture, new RegExp(value, "u"));
  }
  for (const value of ["Capability is not permission", "Formal memory", "Human takeover"]) {
    assert.match(capabilities, new RegExp(value, "u"));
  }
  for (const value of ["Install an immutable revision", "Forward-only migration boundary", "Deployment never turns on real sending"]) {
    assert.match(deployment, new RegExp(value, "u"));
  }
});

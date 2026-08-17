import { capabilityCatalog } from "./capability-policy.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";

const capabilityLabels = Object.freeze({
  observe_messages: "读取授权消息",
  knowledge_read: "读取项目授权的精确知识页",
  repository_activity_read: "读取指定日期的仓库活动",
  project_work_history_read: "读取指定日期的受治理项目工作历史",
  research: "研究与方案分析",
  work_plan_proposal: "生成工作计划提案",
  reply_draft: "生成回复草稿",
  document_draft: "文档草稿",
  project_memory_proposal: "从固定来源形成受治理项目记忆",
  code_patch: "代码补丁",
  local_branch: "隔离分支和本地提交",
  local_test: "运行项目登记的测试",
  dingtalk_send: "发送受控钉钉消息",
  shared_document_write: "创建固定目标的共享文档",
  dingtalk_todo_create: "创建固定人员范围的钉钉待办",
  dingtalk_calendar_create: "创建受控钉钉日程",
  dingtalk_report_submit: "提交固定模板钉钉日志",
  git_push: "推送受控 Git 分支",
  github_pr_draft: "创建可核验的 GitHub PR 草稿",
  production_deploy: "执行带验收和回滚的生产发布",
});

function compact(value, maximum = 40) {
  const text = String(value ?? "").trim().replaceAll(/\s+/gu, " ");
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

export function isCapabilityQuestion(content) {
  const text = String(content ?? "")
    .trim()
    .replaceAll(/\s+/gu, " ");
  if (!text || text.length > 120) return false;
  return /(?:你|foursday|ai\s*员工|这个\s*ai(?:\s*员工)?|机器人)[，,：:\s]{0,4}(?:自己)?(?:目前|现在|到底|究竟)?(?:都)?(?:能做什么|能帮我做什么|能干什么|能干嘛|能干啥|会做什么|可以做什么|可以帮我做什么|可以干什么|可以干嘛|可以做哪些事|擅长什么|有(?:什么|哪些)(?:能力|功能)|支持(?:什么|哪些)(?:能力|功能)?|的?(?:能力|功能)清单)/iu.test(
    text,
  );
}

function activeCapabilities(projects, now) {
  const names = new Set();
  for (const project of projects) {
    for (const [name, rule] of Object.entries(project.capabilities ?? {})) {
      if (
        rule.mode === "disabled" ||
        (rule.expiresAt && new Date(rule.expiresAt) <= now)
      ) {
        continue;
      }
      if (capabilityLabels[name] && capabilityCatalog[name]?.runtime) {
        names.add(name);
      }
    }
  }
  return Object.keys(capabilityLabels).filter((name) => names.has(name));
}

function projectLine(projects, capabilityNames, { isGroup, projectReadFailed }) {
  if (projectReadFailed) {
    return "项目授权状态暂时无法读取；我不会据此声称可以执行项目工作，请在管理台核对。";
  }
  if (projects.length === 0) {
    return "你当前没有已登记的项目授权；项目资料、代码、文档和外部操作不会执行。";
  }
  const projectReference = isGroup
    ? `你已获授权的 ${projects.length} 个项目`
    : `你已获授权的项目（${projects
      .slice(0, 5)
      .map((project) => compact(project.name))
      .join("、")}${projects.length > 5 ? `等 ${projects.length} 个` : ""}）`;
  if (capabilityNames.length === 0) {
    return `${projectReference}目前没有处于有效期内的可执行能力。`;
  }
  return `${projectReference}已配置的有效授权包括：${capabilityNames
    .map((name) => capabilityLabels[name])
    .join("、")}。`;
}

export async function createCapabilityDraft({
  config,
  requesterId,
  isGroup = false,
  now = new Date(),
  manifestLoader = loadProjectManifests,
} = {}) {
  let projects = [];
  let projectReadFailed = false;
  try {
    const manifests = config.projectsDirectory
      ? await manifestLoader(config.projectsDirectory)
      : new Map();
    projects = [...manifests.values()].filter((project) =>
      project.requesters.includes(requesterId),
    );
  } catch {
    projectReadFailed = true;
  }
  const enabled = activeCapabilities(projects, now);
  const globalCapabilities = config.capabilities ?? new Set();
  const canProposePlan =
    globalCapabilities.has("work_plan_proposal") &&
    !projectReadFailed &&
    projects.length > 0;
  const lines = [
    "我目前能做的是：",
    "1. 在白名单消息中判断是否需要回复，并生成可审核的回复草稿。",
  ];
  if (canProposePlan) {
    lines.push("2. 把明确的工作请求整理成包含步骤、风险、验收和回滚的计划提案。");
  }
  lines.push(projectLine(projects, enabled, { isGroup, projectReadFailed }));
  if (globalCapabilities.has("send_message")) {
    const scope = globalCapabilities.has("send_group_message")
      ? "私聊或群聊回复"
      : "私聊回复";
    const automatic = config.autoApproveLowRiskReplies
      ? `高置信低风险私聊${config.autoApproveGroupReplies ? "、明确 @ 我的低风险群聊" : ""}${config.autoApproveClarifications ? "和私聊最小追问" : ""}可自动批准`
      : "每条回复都需人工审批";
    lines.push(`当前模式：${scope}已开放；${automatic}。发送前仍会复查负责人是否已经人工回复。`);
  } else {
    lines.push(
      `当前模式：真实发送关闭，我只产出${canProposePlan ? "判断、草稿和计划提案" : "判断和草稿"}，不会替你发送消息。`,
    );
  }
  if (globalCapabilities.has("work_plan_execution")) {
    lines.push("计划执行已开启，但仍必须同时满足项目授权、当前策略和对应审批。未登记能力不会执行。");
  } else {
    lines.push("计划自动执行关闭；即使形成计划，也只会等待审查，不会自行运行。");
  }
  lines.push("边界：我不处理付款、合同签署、人事决定、OA 审批决定、绕过权限或秘密传播；生产发布等高风险动作必须强审批并具备验收和回滚。执行前还会重新检查工具和授权是否可用。");
  return {
    shouldReply: true,
    reply: lines.join("\n"),
    confidence: 1,
    riskLevel: "low",
    reason: "对方询问 Foursday 能力，依据当前全局开关和请求人项目授权生成确定性说明。",
    needsInformation: false,
    relatedToWaitingTask: false,
    decisionSource: "capability_catalog",
    decisionKind: "capability_summary",
    workRequest: null,
  };
}

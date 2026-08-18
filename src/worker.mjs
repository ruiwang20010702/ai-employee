import { setTimeout as delay } from "node:timers/promises";
import {
  createCapabilityDraft,
  isCapabilityQuestion,
} from "./capability-summary.mjs";
import { loadConfig } from "./config.mjs";
import { generateReplyDraft } from "./draft.mjs";
import { ClaudeCodeAgentRuntime } from "./agent-runtime.mjs";
import {
  assertSuccessfulSendReceipt,
  DwsAdapter,
  isAutomatedSelfMessage,
  normalizeDwsIdentity,
} from "./dws.mjs";
import { safeErrorCode } from "./logging.mjs";
import { routeProjectMemories } from "./project-memory-routing.mjs";
import { notifyPendingMobileApprovals } from "./mobile-approval.mjs";
import { sanitizeDraftMemoryCandidates } from "./memory-candidate.mjs";
import { proposeWorkPlanForTask } from "./plan-proposal.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import { createProductionStore } from "./production-store.mjs";
import { createPersonalMemoryClient } from "./personal-memory-client.mjs";
import { isMainModule } from "./main-module.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

function runtimeForConfig(config) {
  if (config.agentRuntime !== "claude-code") return undefined;
  return new ClaudeCodeAgentRuntime({ executable: config.claudeCodePath });
}

async function findManualReply(dws, {
  conversationId,
  selfUserId,
  after,
  now,
  automatedSendEvidence: evidence,
}) {
  if (typeof dws.findManualReply === "function") {
    return dws.findManualReply({
      conversationId,
      selfIdentityId: selfUserId,
      after,
      now,
      automatedSendEvidence: evidence,
    });
  }
  return dws.hasManualReply({
    conversationId,
    selfUserId,
    after,
    now,
    automatedSendEvidence: evidence,
  });
}

export function classifyDirectConversationRoles(messages, task) {
  const sourceMessageIds = new Set([
    ...(task.payload?.messageIds ?? []),
    task.payload?.latestMessageId,
    ...(task.payload?.messages ?? []).map((message) => message.id),
  ].filter(Boolean).map(String));
  const participantOpenIds = new Set(
    messages
      .filter((message) => sourceMessageIds.has(String(message.id ?? "")))
      .map((message) => String(message.senderOpenDingTalkId ?? "").trim())
      .filter(Boolean),
  );
  const participantName = String(task.payload?.senderName ?? "").trim();
  return messages.map((message) => {
    const messageId = String(message.id ?? "");
    const senderOpenId = String(message.senderOpenDingTalkId ?? "").trim();
    const rawSenderName = typeof message.raw?.sender === "string"
      ? message.raw.sender.trim()
      : "";
    let role = "unknown";
    if (sourceMessageIds.has(messageId)) {
      role = "other";
    } else if (participantOpenIds.size === 1 && senderOpenId) {
      role = participantOpenIds.has(senderOpenId) ? "other" : "self";
    } else if (message.isSelf === true) {
      role = "self";
    } else if (participantName && rawSenderName === participantName) {
      role = "other";
    }
    return {
      ...message,
      role,
      isSelf: role === "self" ? true : role === "other" ? false : null,
    };
  });
}

async function conversationForTask(dws, task) {
  const latestCreateTime = new Date(task.payload?.latestCreateTime ?? task.created_at);
  const before = Number.isNaN(latestCreateTime.getTime())
    ? new Date()
    : new Date(latestCreateTime.getTime() + 1_000);
  let messages;
  const usesConversationContract = typeof dws.getConversation === "function";
  if (usesConversationContract) {
    messages = await dws.getConversation({
      conversationId: task.conversation_id,
      participantId: task.sender_user_id,
      before,
      limit: 50,
      lookbackMs: 24 * 60 * 60 * 1_000,
    });
  } else {
    messages = await dws.fetchDirect({
      userId: task.sender_user_id,
      before,
      limit: 50,
      lookbackMs: 24 * 60 * 60 * 1_000,
    });
  }
  const classified = classifyDirectConversationRoles(messages, task);
  if (usesConversationContract) {
    const sourceMessageIds = new Set([
      ...(task.payload?.messageIds ?? []),
      task.payload?.latestMessageId,
    ].filter(Boolean).map(String));
    if (
      sourceMessageIds.size > 0 &&
      !classified.some((message) => sourceMessageIds.has(String(message.id ?? "")))
    ) {
      const error = new Error("Direct conversation context is missing the source message");
      error.code = "direct_context_source_missing";
      throw error;
    }
  }
  return classified;
}

async function sendThroughAdapter(dws, task, { isGroup, text }) {
  if (typeof dws.sendMessage === "function") {
    const receipt = await dws.sendMessage({
      conversationId: task.conversation_id,
      recipientId: task.sender_user_id,
      chatType: isGroup ? "group" : "direct",
      text,
      idempotencyKey: task.id,
    });
    await dws.verifySendReceipt(receipt);
    return receipt;
  }
  const receipt = isGroup
    ? await dws.sendGroupText({
        groupId: task.conversation_id,
        text,
        idempotencyKey: task.id,
      })
    : await dws.sendText({
        userId: task.sender_user_id,
        text,
        idempotencyKey: task.id,
      });
  assertSuccessfulSendReceipt(receipt);
  return receipt;
}

async function automatedSendEvidence(store, after, now = new Date()) {
  if (!store.listAutomatedSendEvidence) return [];
  const afterTime = new Date(after).getTime();
  if (!Number.isFinite(afterTime)) return [];
  return store.listAutomatedSendEvidence({
    since: new Date(afterTime - 10 * 60 * 1_000),
    until: now,
  });
}

const activeWorkPlanStatuses = [
  "ready",
  "awaiting_approval",
  "approved",
  "executing",
  "verifying",
];
const maxActiveWorkPlansPerStatus = 10_000;

function manualReplyCheckStart(task) {
  return task.status === "waiting_information"
    ? task.waiting_information_at
    : task.payload?.latestCreateTime;
}

async function listAllActiveWorkPlans(store, initialLimit) {
  if (typeof store.listWorkPlans !== "function") return [];
  const plans = [];
  const requestedInitialLimit = Number.isSafeInteger(initialLimit) && initialLimit > 0
    ? Math.min(initialLimit, maxActiveWorkPlansPerStatus + 1)
    : 100;
  for (const status of activeWorkPlanStatuses) {
    let requestedLimit = requestedInitialLimit;
    for (;;) {
      const current = await store.listWorkPlans({
        status,
        limit: requestedLimit,
      });
      if (!Array.isArray(current)) {
        throw new Error("Active work plan scan returned an invalid result");
      }
      if (current.length < requestedLimit) {
        plans.push(...current);
        break;
      }
      if (requestedLimit >= maxActiveWorkPlansPerStatus + 1) {
        throw new Error(
          `Active work plan scan exceeded safe limit for status: ${status}`,
        );
      }
      requestedLimit = Math.min(
        requestedLimit * 2,
        maxActiveWorkPlansPerStatus + 1,
      );
    }
  }
  return plans;
}

export async function reconcileManualReplies({
  store,
  dws,
  config,
  limit = 100,
  now = new Date(),
}) {
  if (!config.selfUserId) return 0;
  const tasksById = new Map();
  for (const status of ["awaiting_approval", "waiting_information"]) {
    let cursor = null;
    for (;;) {
      const page = await store.listTasks({
        status,
        limit,
        beforeCreatedAt: cursor?.created_at,
        beforeId: cursor?.id,
      });
      for (const task of page) tasksById.set(task.id, task);
      if (page.length < limit) break;
      cursor = page.at(-1);
    }
  }
  const activePlans = await listAllActiveWorkPlans(store, limit);
  const activePlanTaskIds = new Set();
  for (const plan of activePlans) {
    const sourceTaskId = plan.plan?.sourceTaskId;
    if (typeof sourceTaskId !== "string" || !sourceTaskId) continue;
    activePlanTaskIds.add(sourceTaskId);
    if (tasksById.has(sourceTaskId)) continue;
    const task = await store.getTask?.(sourceTaskId);
    if (task) {
      tasksById.set(sourceTaskId, task);
    } else {
      log("worker.active_plan_source_unavailable", {
        planId: plan.id,
        sourceTaskId,
      });
    }
  }
  const tasks = [...tasksById.values()];
  if (tasks.length === 0) return 0;
  const times = tasks
    .map((task) => new Date(manualReplyCheckStart(task)).getTime())
    .filter(Number.isFinite);
  if (times.length === 0) return 0;
  const messages = typeof dws.fetchBySenderAll === "function"
    ? await dws.fetchBySenderAll({
        senderUserId: config.selfUserId,
        start: new Date(Math.min(...times)),
        end: now,
      })
    : null;
  const automatedEvidence = await automatedSendEvidence(
    store,
    new Date(Math.min(...times)),
    now,
  );
  let cancelled = 0;
  for (const task of tasks) {
    const sourceTime = new Date(manualReplyCheckStart(task)).getTime();
    if (!Number.isFinite(sourceTime)) continue;
    const replied = messages
      ? messages.some((message) => {
          const messageTime = new Date(message.createTime).getTime();
          return (
            message.conversationId === task.conversation_id &&
            Number.isFinite(messageTime) &&
            messageTime > sourceTime &&
            !isAutomatedSelfMessage(message, automatedEvidence)
          );
        })
      : (await findManualReply(dws, {
          conversationId: task.conversation_id,
          selfUserId: config.selfUserId,
          after: new Date(sourceTime),
          now,
          automatedSendEvidence: automatedEvidence,
        })).replied;
    if (!replied) continue;
    const taskCancelled = await store.cancelDraftForManualReply(task.id, now);
    if (taskCancelled || activePlanTaskIds.has(task.id)) {
      cancelled += 1;
    }
  }
  if (cancelled > 0) {
    log("worker.drafts_cancelled", {
      count: cancelled,
      reason: "manual_reply_detected",
    });
  }
  return cancelled;
}

async function replyPauseReason(store, task, isGroup) {
  if (!store.isScopedPaused) return null;
  if (await store.isScopedPaused("contact", task.sender_user_id)) {
    return "contact_paused";
  }
  if (
    isGroup &&
    await store.isScopedPaused("group", task.conversation_id)
  ) {
    return "group_paused";
  }
  return null;
}

function configuredIdentityIncludes(values, identity) {
  const normalizedIdentity = normalizeDwsIdentity(identity);
  return normalizedIdentity != null && (values ?? []).some(
    (value) => normalizeDwsIdentity(value) === normalizedIdentity,
  );
}

async function resolveCandidateProject(candidate, task, config) {
  if (candidate.type !== "project") return null;
  if (!config.projectsDirectory) return null;
  const projects = await loadProjectManifests(config.projectsDirectory);
  const hint = candidate.projectHint.trim().toLowerCase();
  const matches = [...projects.values()].filter(
    (project) =>
      project.requesters.includes(task.sender_user_id) &&
      (project.projectId.toLowerCase() === hint ||
        project.name.toLowerCase() === hint),
  );
  return matches.length === 1 ? matches[0].projectId : null;
}

export async function proposeDraftMemoryCandidates({
  store,
  task,
  draft,
  config,
  now = new Date(),
}) {
  const review = sanitizeDraftMemoryCandidates(draft.memoryCandidates);
  const summary = {
    created: 0,
    duplicates: 0,
    conflicts: 0,
    skipped: review.rejectedReasons.length,
    rejectedReasons: [...review.rejectedReasons],
  };
  if (
    review.candidates.length === 0 ||
    typeof store.proposeMemoryCandidate !== "function"
  ) {
    return { ...summary, candidates: review.candidates };
  }
  const allowedSourceIds = new Set(
    (task.payload?.messages ?? []).map((message) => String(message.id ?? "")),
  );
  for (const candidate of review.candidates) {
    try {
      const sourceId = candidate.sourceMessageId;
      if (!allowedSourceIds.has(sourceId)) {
        summary.skipped += 1;
        summary.rejectedReasons.push("source_outside_task_bundle");
        continue;
      }
      const projectId = await resolveCandidateProject(candidate, task, config);
      if (candidate.type === "project" && !projectId) {
        summary.skipped += 1;
        summary.rejectedReasons.push("project_not_authorized_or_ambiguous");
        continue;
      }
      const subject = candidate.type === "person"
        ? task.sender_user_id
        : candidate.type === "project"
          ? projectId
          : "ai_employee_principles";
      const result = await store.proposeMemoryCandidate({
        type: candidate.type,
        subject,
        projectId,
        statement: candidate.statement,
        sourceType: "dingtalk_message",
        sourceId,
        sourceVersion: task.id,
        scope: { factKey: candidate.factKey },
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        expiresAt: new Date(
          now.getTime() + candidate.retentionDays * 86_400_000,
        ),
        createdBy: "system:memory-candidate",
      }, now);
      if (result.created) {
        summary.created += 1;
        if (result.conflictCount > 0) summary.conflicts += 1;
      } else if (result.reason === "duplicate") {
        summary.duplicates += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.skipped += 1;
      summary.rejectedReasons.push(`storage_${safeErrorCode(error)}`);
    }
  }
  return { ...summary, candidates: review.candidates };
}

export function autoApprovalEligible({ draft, isGroup, config, completion }) {
  const baseEligible = config.autoApproveLowRiskReplies === true &&
    config.capabilities.has("send_message") &&
    completion?.status === "awaiting_approval" &&
    draft.shouldReply === true &&
    draft.workRequest?.requested !== true &&
    draft.riskLevel === "low" &&
    Number(draft.confidence) >= Number(config.autoApproveMinimumConfidence ?? 0.95);
  if (!baseEligible) return false;
  if (draft.needsInformation === true) {
    return isGroup === false && config.autoApproveClarifications === true;
  }
  if (isGroup) return config.autoApproveGroupReplies === true;
  return true;
}

const requestedCapabilityPatterns = Object.freeze([
  ["production_deploy", /(?:部署|上线|发布生产|production\s+deploy)/iu],
  ["git_push", /(?:git\s+push|推送(?:代码|分支|提交))/iu],
  ["github_pr_draft", /(?:创建|提交|开)(?:一个)?\s*(?:draft\s*)?(?:pr|pull request)/iu],
  ["local_test", /(?:运行|执行|跑)(?:一下)?(?:测试|test|check)/iu],
  ["code_patch", /(?:修改|修复|实现|改)(?:一下|下)?(?:代码|功能|bug|缺陷)/iu],
  ["dingtalk_todo_create", /(?:创建|新建|添加)(?:钉钉)?待办/iu],
  ["dingtalk_calendar_create", /(?:创建|新建|安排)(?:钉钉)?(?:日程|会议)/iu],
  ["dingtalk_report_submit", /(?:提交|发送|填写)(?:钉钉)?(?:日报|周报|日志)/iu],
  ["document_draft", /(?:撰写|起草|写)(?:一份|一个)?(?:文档|方案|prd|报告)/iu],
  ["research", /(?:研究|调研|分析)(?:一下|下)?/iu],
]);

const prohibitedWorkPattern = /(?:转账|付款|支付|签署合同|代签|录用|辞退|调薪|绩效决定|审批通过|绕过(?:审批|权限))|(?:(?:泄露|提供|发送)[^。！？\n]{0,12}(?:密码|令牌|密钥|私钥|cookie|凭据))/iu;

export async function applyExecutionBoundary({ draft, task, config }) {
  if (draft.workRequest?.requested !== true) return draft;
  const objective = String(draft.workRequest.objective ?? "").trim();
  if (prohibitedWorkPattern.test(objective)) {
    return {
      ...draft,
      reply: "这项请求涉及我明确不能代办的高风险或越权操作，我暂时无法执行。请由负责人在正式业务系统中处理；我可以在不接触秘密、不替人作决定的前提下协助整理材料。",
      confidence: 1,
      riskLevel: "low",
      reason: "请求命中禁止执行边界，返回确定性能力不足说明。",
      needsInformation: false,
      workRequest: null,
      decisionSource: "authorization_boundary",
      decisionKind: "prohibited_request",
    };
  }
  if (!config.projectsDirectory) return draft;
  let projects;
  try {
    projects = config.projectsDirectory
      ? await loadProjectManifests(config.projectsDirectory)
      : new Map();
  } catch {
    return {
      ...draft,
      reply: "项目授权状态暂时无法核对，我现在不能安全执行这项工作。请稍后重试或由负责人在 Foursday 管理台检查项目授权。",
      confidence: 1,
      riskLevel: "low",
      reason: "项目授权不可用时按失败关闭处理。",
      needsInformation: false,
      workRequest: null,
      decisionSource: "authorization_boundary",
      decisionKind: "authorization_unavailable",
    };
  }
  const eligible = [...projects.values()].filter((project) =>
    project.requesters.includes(task.sender_user_id),
  );
  const hint = String(draft.workRequest.projectHint ?? "").trim().toLowerCase();
  const exact = hint
    ? eligible.filter((project) =>
        project.projectId.toLowerCase() === hint || project.name.toLowerCase() === hint)
    : [];
  const project = exact.length === 1
    ? exact[0]
    : eligible.length === 1 && !hint
      ? eligible[0]
      : null;
  if (!project) {
    if (eligible.length > 1) {
      return {
        ...draft,
        reply: `我目前能访问多个已授权项目，请先告诉我这项工作属于哪个项目：${eligible.slice(0, 5).map((item) => item.name).join("、")}。`,
        confidence: 1,
        riskLevel: "low",
        reason: "执行请求缺少唯一项目，需要一次最小澄清。",
        needsInformation: true,
        workRequest: null,
        decisionSource: "authorization_boundary",
        decisionKind: "project_ambiguous",
      };
    }
    return {
      ...draft,
      reply: "这项工作目前不在我被授予的项目范围内，我暂时无法代你执行。请由负责人先在 Foursday 中授权对应项目和能力。",
      confidence: 1,
      riskLevel: "low",
      reason: "请求人没有唯一匹配的项目授权。",
      needsInformation: false,
      workRequest: null,
      decisionSource: "authorization_boundary",
      decisionKind: "project_not_authorized",
    };
  }
  const required = requestedCapabilityPatterns
    .filter(([, pattern]) => pattern.test(objective))
    .map(([capability]) => capability);
  const unavailable = required.filter((capability) => {
    const rule = project.capabilities?.[capability];
    return !rule || rule.mode === "disabled" ||
      (rule.expiresAt && new Date(rule.expiresAt) <= new Date());
  });
  if (unavailable.length > 0) {
    return {
      ...draft,
      reply: `当前项目尚未授权这项操作（${unavailable.join("、")}），我暂时无法代执行。我可以先整理方案，或请负责人在 Foursday 中补充对应能力授权。`,
      confidence: 1,
      riskLevel: "low",
      reason: "请求所需能力未在当前项目开放。",
      needsInformation: false,
      workRequest: null,
      decisionSource: "authorization_boundary",
      decisionKind: "capability_not_authorized",
    };
  }
  return draft;
}

export async function processDraftTask({
  store,
  dws,
  config,
  generator,
  planProposer = proposeWorkPlanForTask,
  personalMemoryClient = null,
}) {
  if (!config.capabilities.has("draft_reply")) return false;
  const task = await store.claimTask();
  if (!task) return false;
  const isGroup = configuredIdentityIncludes(
    config.targetGroupIds,
    task.conversation_id,
  );
  const completeDraft = (draft) => store.completeDraft(
    task.id,
    draft,
    new Date(),
    {
      supersedeWindowMs: isGroup
        ? 0
        : Number(config.bundleGapMs ?? 120_000),
    },
  );
  const pausedReason = await replyPauseReason(store, task, isGroup);
  if (pausedReason) {
    await store.deferTaskForPause(task.id);
    log("worker.task_deferred", {
      taskId: task.id,
      reason: pausedReason,
    });
    return true;
  }
  try {
    const latestAt = new Date(task.payload.latestCreateTime).getTime();
    if (
      Number.isFinite(latestAt) &&
      Number.isFinite(config.replyMaxAgeMs) &&
      Date.now() - latestAt > config.replyMaxAgeMs
    ) {
      await completeDraft({
        shouldReply: false,
        reply: "",
        confidence: 1,
        riskLevel: "low",
        reason: "消息已超过自动回复时效，仅保留记录。",
        needsInformation: false,
        relatedToWaitingTask: false,
        decisionSource: "hard-rule",
        decisionKind: "stale_message",
      });
      return true;
    }
    if (config.selfUserId) {
      try {
        const manual = await findManualReply(dws, {
          conversationId: task.conversation_id,
          selfUserId: config.selfUserId,
          after: task.payload.waitingTask?.waitingAt ??
            task.payload.latestCreateTime,
          automatedSendEvidence: await automatedSendEvidence(
            store,
            task.payload.waitingTask?.waitingAt ??
              task.payload.latestCreateTime,
          ),
        });
        if (manual.known && manual.replied) {
          await completeDraft({
            shouldReply: false,
            reply: "",
            confidence: 1,
            riskLevel: "low",
            reason: "负责人已经人工回复。",
            needsInformation: false,
            relatedToWaitingTask: false,
            decisionSource: "manual_reply_check",
            decisionKind: "manual_reply",
          });
          return true;
        }
      } catch (error) {
        log("worker.manual_reply_advisory_unavailable", {
          taskId: task.id,
          errorCode: safeErrorCode(error),
        });
      }
    }
    if (isCapabilityQuestion(task.payload.content)) {
      const draft = await createCapabilityDraft({
        config,
        requesterId: task.sender_user_id,
        isGroup,
      });
      await completeDraft(draft);
      log("worker.capability_summary_completed", {
        taskId: task.id,
        projectScope: isGroup ? "count_only" : "authorized_names",
      });
      return true;
    }
    let conversation = [];
    if (!isGroup) {
      try {
        conversation = await conversationForTask(dws, task);
      } catch (error) {
        log("worker.direct_context_unavailable", {
          taskId: task.id,
          errorCode: safeErrorCode(error),
        });
        throw new Error(
          `direct context unavailable: ${safeErrorCode(error)}`,
        );
      }
    }
    let projectIdentityMemories = [];
    try {
      const projects = await (store.searchMemories?.({ type: "project", limit: 200 }) ?? []);
      const projectText = [
        ...conversation.map((message) => message.content),
        task.payload.content,
      ].join("\n");
      const projectIndex = projects.filter((memory) =>
        memory.source_type === "operator_confirmed_project_index" &&
        memory.scope?.factKey === "identity.project_aliases"
      );
      projectIdentityMemories = routeProjectMemories({
        text: projectText,
        memories: projectIndex,
      });
    } catch (error) {
      log("worker.project_identity_context_unavailable", {
        taskId: task.id,
        errorCode: safeErrorCode(error),
      });
    }
    let personalMemory = [];
    if (config.personalMemoryEnabled) {
      if (!personalMemoryClient) {
        throw new Error("personal memory client is unavailable");
      }
      const memoryQuery = [
        ...conversation.slice(-20).map((message) => message.content),
        task.payload.content,
        ...projectIdentityMemories.flatMap((memory) => [
          memory.scope?.canonicalName,
          ...(Array.isArray(memory.scope?.aliases) ? memory.scope.aliases : []),
        ]),
      ].filter(Boolean).join("\n");
      try {
        personalMemory = await personalMemoryClient.searchContext(memoryQuery, {
          limit: config.personalMemoryMaxResults ?? 8,
        });
      } catch (error) {
        log("worker.personal_memory_unavailable", {
          taskId: task.id,
          errorCode: safeErrorCode(error),
        });
        throw new Error(`personal memory unavailable: ${safeErrorCode(error)}`);
      }
    }
    const generatedDraft = await generator(
      {
        taskId: task.id,
        content: task.payload.content,
        messages: task.payload.messages,
        chatType: isGroup ? "group" : "direct",
        mentionedSelf: isGroup ? true : undefined,
        waitingTask: task.payload.waitingTask ?? null,
      },
      {
        codexPath: config.codexPath,
        runtime: runtimeForConfig(config),
        conversation,
        memories: [],
        personalMemory,
      },
    );
    if (config.selfUserId) {
      let manual;
      try {
        manual = await findManualReply(dws, {
          conversationId: task.conversation_id,
          selfUserId: config.selfUserId,
          after: task.payload.waitingTask?.waitingAt ??
            task.payload.latestCreateTime,
          automatedSendEvidence: await automatedSendEvidence(
            store,
            task.payload.waitingTask?.waitingAt ??
              task.payload.latestCreateTime,
          ),
        });
      } catch (error) {
        throw new Error(
          `manual reply recheck unavailable: ${safeErrorCode(error)}`,
        );
      }
      if (!manual.known) {
        throw new Error("manual reply recheck unavailable");
      }
      if (manual.replied) {
        await store.cancelDraftForManualReply(task.id);
        log("worker.draft_cancelled", {
          taskId: task.id,
          reason: "manual_reply_during_generation",
        });
        return true;
      }
    }
    const memoryReview = sanitizeDraftMemoryCandidates(
      generatedDraft.memoryCandidates,
    );
    const boundedDraft = await applyExecutionBoundary({
      draft: generatedDraft,
      task,
      config,
    });
    const draft = {
      ...boundedDraft,
      memoryCandidates: memoryReview.candidates,
    };
    const completion = await completeDraft(draft);
    if (completion?.status === "expired") {
      log("worker.draft_superseded", {
        taskId: task.id,
        reason: "newer_conversation_message",
      });
      return true;
    }
    const memorySummary = await proposeDraftMemoryCandidates({
      store,
      task,
      draft,
      config,
    });
    if (
      memorySummary.created > 0 ||
      memorySummary.duplicates > 0 ||
      memorySummary.skipped > 0 ||
      memoryReview.rejectedReasons.length > 0
    ) {
      log("worker.memory_candidates_reviewed", {
        taskId: task.id,
        created: memorySummary.created,
        duplicates: memorySummary.duplicates,
        conflicts: memorySummary.conflicts,
        skipped: memorySummary.skipped + memoryReview.rejectedReasons.length,
        reasons: [...new Set([
          ...memoryReview.rejectedReasons,
          ...memorySummary.rejectedReasons,
        ])],
      });
    }
    if (autoApprovalEligible({ draft, isGroup, config, completion })) {
      await store.decideTask(task.id, {
        decision: "approved",
        actor: "system:auto-approve-low-risk-reply",
        reason: "bounded_low_risk_direct_reply",
      });
      log("worker.draft_auto_approved", {
        taskId: task.id,
        riskLevel: draft.riskLevel,
        confidence: draft.confidence,
        chatType: isGroup ? "group" : "direct",
        clarification: draft.needsInformation === true,
      });
    }
    if (
      draft.shouldReply === true &&
      !draft.needsInformation &&
      draft.workRequest?.requested === true
    ) {
      try {
        const beforeRegister = config.selfUserId
          ? async () => {
              let manual;
              try {
                manual = await findManualReply(dws, {
                  conversationId: task.conversation_id,
                  selfUserId: config.selfUserId,
                  after: task.payload.waitingTask?.waitingAt ??
                    task.payload.latestCreateTime,
                  automatedSendEvidence: await automatedSendEvidence(
                    store,
                    task.payload.waitingTask?.waitingAt ??
                      task.payload.latestCreateTime,
                  ),
                });
              } catch (error) {
                throw new Error(
                  `manual reply plan recheck unavailable: ${safeErrorCode(error)}`,
                );
              }
              if (!manual.known) {
                throw new Error("manual reply plan recheck unavailable");
              }
              if (!manual.replied) return true;
              await store.cancelDraftForManualReply(task.id);
              log("worker.work_plan_cancelled", {
                taskId: task.id,
                reason: "manual_reply_during_planning",
              });
              return false;
            }
          : undefined;
        const proposal = await planProposer({
          store,
          config,
          task,
          draft,
          beforeRegister,
        });
        log("worker.work_plan_proposal", {
          taskId: task.id,
          created: proposal.created,
          planId: proposal.planId,
          reason: proposal.reason,
        });
      } catch (error) {
        log("worker.work_plan_proposal_failed", {
          taskId: task.id,
          errorCode: safeErrorCode(error),
        });
      }
    }
    log("worker.draft_completed", {
      taskId: task.id,
      shouldReply: draft.shouldReply,
      riskLevel: draft.riskLevel,
    });
  } catch (error) {
    const status = await store.failTask(task.id, error);
    log("worker.draft_failed", {
      taskId: task.id,
      status,
      errorCode: safeErrorCode(error),
    });
  }
  return true;
}

export async function processApprovedTask({ store, dws, config }) {
  if (!config.capabilities.has("send_message")) return false;
  if (!config.selfUserId) {
    log("worker.send_blocked", {
      reason: "DINGTALK_SELF_USER_ID is required for manual reply detection",
    });
    return false;
  }

  const task = await store.claimApprovedTask();
  if (!task) return false;
  const isGroup = configuredIdentityIncludes(
    config.targetGroupIds,
    task.conversation_id,
  );
  if (
    !isGroup &&
    !configuredIdentityIncludes(config.targetUserIds, task.sender_user_id)
  ) {
    await store.returnApprovedTask(task.id, "sender_not_allowlisted");
    log("worker.send_blocked", {
      taskId: task.id,
      reason: "sender_not_allowlisted",
    });
    return true;
  }
  const pausedReason = await replyPauseReason(store, task, isGroup);
  if (pausedReason) {
    await store.returnApprovedTask(task.id, pausedReason);
    log("worker.send_deferred", {
      taskId: task.id,
      reason: pausedReason,
    });
    return true;
  }
  if (isGroup && !config.capabilities.has("send_group_message")) {
    await store.returnApprovedTask(
      task.id,
      "Group sending requires the separate send_group_message capability",
    );
    return true;
  }
  const reply = task.result?.reply?.trim();
  if (!reply) {
    await store.markSideEffectUnknown(
      task.id,
      "send_message",
      new Error("Approved task has no reply text"),
    );
    return true;
  }

  let manual;
  try {
    manual = await findManualReply(dws, {
      conversationId: task.conversation_id,
      selfUserId: config.selfUserId,
      after: task.payload.latestCreateTime,
      automatedSendEvidence: await automatedSendEvidence(
        store,
        task.payload.latestCreateTime,
      ),
    });
  } catch (error) {
    await store.returnApprovedTask(
      task.id,
      `manual reply check failed: ${error.message}`,
    );
    return true;
  }
  if (!manual.known) {
    await store.returnApprovedTask(task.id, manual.reason);
    return true;
  }
  if (manual.replied) {
    await store.cancelForManualReply(task.id);
    log("worker.send_cancelled", {
      taskId: task.id,
      reason: "manual_reply_detected",
    });
    return true;
  }

  try {
    const effect = await store.beginSideEffect(task.id, "send_message");
    if (effect.status === "completed") {
      const receipt = JSON.parse(effect.receipt_json ?? "{}");
      if (typeof dws.verifySendReceipt === "function") {
        await dws.verifySendReceipt(receipt);
      } else {
        assertSuccessfulSendReceipt(receipt);
      }
      await store.completeSideEffect(
        task.id,
        "send_message",
        receipt,
      );
      return true;
    }
    if (
      effect.status === "started" &&
      Date.now() - new Date(effect.updated_at).getTime() > 23 * 60 * 60 * 1000
    ) {
      throw new Error(
        "Previous send result is older than the adapter idempotency window",
      );
    }
    const receipt = await sendThroughAdapter(dws, task, {
      isGroup,
      text: reply,
    });
    await store.completeSideEffect(task.id, "send_message", receipt);
    log("worker.send_completed", { taskId: task.id });
  } catch (error) {
    await store.markSideEffectUnknown(task.id, "send_message", error);
    log("worker.send_unknown", {
      taskId: task.id,
      errorCode: safeErrorCode(error),
    });
  }
  return true;
}

export async function runWorker({
  config = loadConfig({ production: true }),
  store = null,
  dws = new DwsAdapter(config),
  generator = generateReplyDraft,
  personalMemoryClient = undefined,
  once = process.argv.includes("--once"),
} = {}) {
  store = store ? await store.open() : await createProductionStore(config);
  if (personalMemoryClient === undefined) {
    personalMemoryClient = createPersonalMemoryClient(config);
  }
  let stopped = false;
  let lastHeartbeatAt = 0;
  let lastManualReplyCheckAt = 0;
  let lastMobileApprovalCheckAt = 0;
  let heartbeatTimer;
  const stopController = new AbortController();

  const interruptibleDelay = async () => {
    try {
      await delay(config.workerPollMs, undefined, {
        signal: stopController.signal,
      });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  };

  const tick = async () => {
    if (Date.now() - lastHeartbeatAt >= config.heartbeatMs) {
      await store.recordHeartbeat?.("worker");
      lastHeartbeatAt = Date.now();
    }
    let reconciled = 0;
    let expired = 0;
    if (
      Date.now() - lastManualReplyCheckAt >= config.manualReplyRecheckMs
    ) {
      lastManualReplyCheckAt = Date.now();
      try {
        if (Number.isFinite(config.draftApprovalTtlMs)) {
          expired = await store.expireAwaitingDrafts({
            before: new Date(Date.now() - config.draftApprovalTtlMs),
          });
        }
        reconciled = await reconcileManualReplies({ store, dws, config });
        await store.setCheckpoint?.(
          "worker:manual-reply:last-success",
          new Date().toISOString(),
        );
      } catch (error) {
        const errorCode = safeErrorCode(error);
        await store.setCheckpoint?.(
          "worker:manual-reply:last-failure",
          errorCode,
        );
        log("worker.manual_reply_check_failed", { errorCode });
      }
    }
    if (await store.isPaused()) return expired > 0 || reconciled > 0;
    let mobileNotifications = 0;
    if (
      config.mobileApprovalEnabled &&
      Date.now() - lastMobileApprovalCheckAt >= config.mobileApprovalNotifyIntervalMs
    ) {
      lastMobileApprovalCheckAt = Date.now();
      try {
        const mobile = await notifyPendingMobileApprovals({ store, dws, config });
        mobileNotifications = mobile.sent;
        if (mobile.sent > 0) log("mobile_approval.notified", { count: mobile.sent });
      } catch (error) {
        log("mobile_approval.notification_error", {
          errorCode: safeErrorCode(error),
        });
      }
    }
    const draftResults = await Promise.all(
      Array.from(
        { length: config.workerConcurrency ?? 1 },
        () => processDraftTask({
          store,
          dws,
          config,
          generator,
          personalMemoryClient,
        }),
      ),
    );
    const drafted = draftResults.some(Boolean);
    const sent = await processApprovedTask({ store, dws, config });
    return expired > 0 || reconciled > 0 || mobileNotifications > 0 || drafted || sent;
  };

  if (once) {
    while (await tick()) {
      // Drain tasks deterministically for scripts and tests.
    }
    await store.close();
    return { stop() {} };
  }

  log("worker.started", {
    capabilities: [...config.capabilities],
    draftConcurrency: config.workerConcurrency ?? 1,
    sendEnabled: config.capabilities.has("send_message"),
  });
  heartbeatTimer = setInterval(() => {
    if (stopped) return;
    store.recordHeartbeat?.("worker")?.catch((error) => {
      log("worker.heartbeat_error", { errorCode: safeErrorCode(error) });
    });
  }, config.heartbeatMs);
  const loop = (async () => {
    while (!stopped) {
      try {
        const worked = await tick();
        if (!worked) await interruptibleDelay();
      } catch (error) {
        log("worker.error", { errorCode: safeErrorCode(error) });
        if (!stopped) await interruptibleDelay();
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      stopController.abort();
      await loop;
      await store.close();
      log("worker.stopped");
    },
  };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const worker = await runWorker();
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

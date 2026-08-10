import { setTimeout as delay } from "node:timers/promises";
import {
  createCapabilityDraft,
  isCapabilityQuestion,
} from "./capability-summary.mjs";
import { loadConfig } from "./config.mjs";
import { generateReplyDraft } from "./draft.mjs";
import {
  assertSuccessfulSendReceipt,
  DwsAdapter,
  isAutomatedSelfMessage,
  normalizeDwsIdentity,
} from "./dws.mjs";
import { safeErrorCode } from "./logging.mjs";
import { sanitizeDraftMemoryCandidates } from "./memory-candidate.mjs";
import { proposeWorkPlanForTask } from "./plan-proposal.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import { createProductionStore } from "./production-store.mjs";
import { isMainModule } from "./main-module.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
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
  const messages = await dws.fetchBySenderAll({
    senderUserId: config.selfUserId,
    start: new Date(Math.min(...times)),
    end: now,
  });
  const automatedEvidence = await automatedSendEvidence(
    store,
    new Date(Math.min(...times)),
    now,
  );
  let cancelled = 0;
  for (const task of tasks) {
    const sourceTime = new Date(manualReplyCheckStart(task)).getTime();
    if (!Number.isFinite(sourceTime)) continue;
    const replied = messages.some((message) => {
      const messageTime = new Date(message.createTime).getTime();
      return (
        message.conversationId === task.conversation_id &&
        Number.isFinite(messageTime) &&
        messageTime > sourceTime &&
        !isAutomatedSelfMessage(message, automatedEvidence)
      );
    });
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

export async function processDraftTask({
  store,
  dws,
  config,
  generator,
  planProposer = proposeWorkPlanForTask,
}) {
  if (!config.capabilities.has("draft_reply")) return false;
  const task = await store.claimTask();
  if (!task) return false;
  const isGroup = configuredIdentityIncludes(
    config.targetGroupIds,
    task.conversation_id,
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
      await store.completeDraft(task.id, {
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
        const manual = await dws.hasManualReply({
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
          await store.completeDraft(task.id, {
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
      await store.completeDraft(task.id, draft);
      log("worker.capability_summary_completed", {
        taskId: task.id,
        projectScope: isGroup ? "count_only" : "authorized_names",
      });
      return true;
    }
    let conversation = [];
    if (!isGroup) {
      try {
        conversation = await dws.fetchDirect({
          userId: task.sender_user_id,
          limit: 50,
        });
      } catch (error) {
        log("worker.direct_context_unavailable", {
          taskId: task.id,
          errorCode: safeErrorCode(error),
        });
      }
    }
    let memories = [];
    try {
      const [principles, person] = await Promise.all([
        store.searchMemories?.({ type: "principle" }) ?? [],
        store.searchMemories?.({
          type: "person",
          subject: task.sender_user_id,
        }) ?? [],
      ]);
      memories = [...principles, ...person].filter(
        (memory) => memory.sensitivity !== "confidential",
      );
    } catch (error) {
      log("worker.memory_context_unavailable", {
        taskId: task.id,
        errorCode: safeErrorCode(error),
      });
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
        conversation,
        memories,
      },
    );
    if (config.selfUserId) {
      let manual;
      try {
        manual = await dws.hasManualReply({
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
    const draft = {
      ...generatedDraft,
      memoryCandidates: memoryReview.candidates,
    };
    await store.completeDraft(task.id, draft);
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
                manual = await dws.hasManualReply({
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
    manual = await dws.hasManualReply({
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
      assertSuccessfulSendReceipt(receipt);
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
        "Previous send result is older than the DWS idempotency window",
      );
    }
    const receipt = isGroup
      ? await dws.sendGroupText({
          groupId: task.conversation_id,
          text: reply,
          idempotencyKey: task.id,
        })
      : await dws.sendText({
          userId: task.sender_user_id,
          text: reply,
          idempotencyKey: task.id,
        });
    assertSuccessfulSendReceipt(receipt);
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
  once = process.argv.includes("--once"),
} = {}) {
  store = store ? await store.open() : await createProductionStore(config);
  let stopped = false;
  let lastHeartbeatAt = 0;
  let lastManualReplyCheckAt = 0;
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
    const drafted = await processDraftTask({ store, dws, config, generator });
    const sent = await processApprovedTask({ store, dws, config });
    return expired > 0 || reconciled > 0 || drafted || sent;
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

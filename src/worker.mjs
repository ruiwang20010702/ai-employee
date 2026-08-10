import { setTimeout as delay } from "node:timers/promises";
import {
  createCapabilityDraft,
  isCapabilityQuestion,
} from "./capability-summary.mjs";
import { loadConfig } from "./config.mjs";
import { generateReplyDraft } from "./draft.mjs";
import { assertSuccessfulSendReceipt, DwsAdapter } from "./dws.mjs";
import { safeErrorCode } from "./logging.mjs";
import { proposeWorkPlanForTask } from "./plan-proposal.mjs";
import { createProductionStore } from "./production-store.mjs";
import { isMainModule } from "./main-module.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

export async function reconcileManualReplies({
  store,
  dws,
  config,
  limit = 100,
  now = new Date(),
}) {
  if (!config.selfUserId) return 0;
  const tasks = [];
  let cursor = null;
  for (;;) {
    const page = await store.listTasks({
      status: "awaiting_approval",
      limit,
      beforeCreatedAt: cursor?.created_at,
      beforeId: cursor?.id,
    });
    tasks.push(...page);
    if (page.length < limit) break;
    cursor = page.at(-1);
  }
  if (tasks.length === 0) return 0;
  const times = tasks
    .map((task) => new Date(task.payload.latestCreateTime).getTime())
    .filter(Number.isFinite);
  if (times.length === 0) return 0;
  const messages = await dws.fetchBySenderAll({
    senderUserId: config.selfUserId,
    start: new Date(Math.min(...times)),
    end: now,
  });
  let cancelled = 0;
  for (const task of tasks) {
    const sourceTime = new Date(task.payload.latestCreateTime).getTime();
    if (!Number.isFinite(sourceTime)) continue;
    const replied = messages.some((message) => {
      const messageTime = new Date(message.createTime).getTime();
      return (
        message.conversationId === task.conversation_id &&
        Number.isFinite(messageTime) &&
        messageTime > sourceTime
      );
    });
    if (!replied) continue;
    if (await store.cancelDraftForManualReply(task.id, now)) {
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
  const isGroup = (config.targetGroupIds ?? []).includes(task.conversation_id);
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
          after: task.payload.latestCreateTime,
        });
        if (manual.known && manual.replied) {
          await store.completeDraft(task.id, {
            shouldReply: false,
            reply: "",
            confidence: 1,
            riskLevel: "low",
            reason: "负责人已经人工回复。",
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
    const draft = await generator(
      {
        taskId: task.id,
        content: task.payload.content,
        messages: task.payload.messages,
        chatType: isGroup ? "group" : "direct",
        mentionedSelf: isGroup ? true : undefined,
      },
      {
        codexPath: config.codexPath,
        conversation,
        memories,
      },
    );
    await store.completeDraft(task.id, draft);
    if (draft.workRequest?.requested === true) {
      try {
        const proposal = await planProposer({ store, config, task, draft });
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
  const isGroup = (config.targetGroupIds ?? []).includes(task.conversation_id);
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
    if (await store.isPaused()) return false;
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

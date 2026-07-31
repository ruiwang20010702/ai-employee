import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { generateReplyDraft } from "./draft.mjs";
import { DwsAdapter } from "./dws.mjs";
import { createProductionStore } from "./production-store.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

export async function processDraftTask({ store, dws, config, generator }) {
  if (!config.capabilities.has("draft_reply")) return false;
  const task = await store.claimTask();
  if (!task) return false;
  try {
    if (config.selfUserId) {
      const manual = await dws.hasManualReply({
        userId: task.sender_user_id,
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
    }
    const conversation = await dws.fetchDirect({
      userId: task.sender_user_id,
      limit: 50,
    });
    const draft = await generator(
      {
        taskId: task.id,
        content: task.payload.content,
        messages: task.payload.messages,
      },
      {
        codexPath: config.codexPath,
        conversation,
      },
    );
    await store.completeDraft(task.id, draft);
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
      message: error.message,
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
      userId: task.sender_user_id,
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
      await store.completeSideEffect(
        task.id,
        "send_message",
        JSON.parse(effect.receipt_json ?? "{}"),
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
    const receipt = await dws.sendText({
      userId: task.sender_user_id,
      text: reply,
      idempotencyKey: task.id,
    });
    await store.completeSideEffect(task.id, "send_message", receipt);
    log("worker.send_completed", { taskId: task.id });
  } catch (error) {
    await store.markSideEffectUnknown(task.id, "send_message", error);
    log("worker.send_unknown", { taskId: task.id, message: error.message });
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

  const tick = async () => {
    if (await store.isPaused()) return false;
    const drafted = await processDraftTask({ store, dws, config, generator });
    const sent = await processApprovedTask({ store, dws, config });
    return drafted || sent;
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
  const loop = (async () => {
    while (!stopped) {
      try {
        const worked = await tick();
        if (!worked) await delay(config.workerPollMs);
      } catch (error) {
        log("worker.error", { message: error.message });
        await delay(config.workerPollMs);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      await store.close();
      log("worker.stopped");
    },
  };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const worker = await runWorker();
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

import { createHash } from "node:crypto";
import { draftSha256 } from "./decision-quality.mjs";

const commandPattern = /^(批准|拒绝)\s+([0-9A-F]{8})$/u;
const checkpointPrefix = "mobile-approval:notified:";
const commandCheckpoint = "mobile-approval:commands:last-success";

function boundedText(value, limit) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function taskDraftSha256(task) {
  return draftSha256(task?.result?.reply ?? "");
}

export function mobileApprovalCode(task) {
  if (!task?.id || !Number.isSafeInteger(Number(task.approval_version))) {
    throw new Error("Mobile approval requires a versioned task");
  }
  const hash = createHash("sha256")
    .update(`${task.id}\n${task.approval_version}\n${taskDraftSha256(task)}`)
    .digest("hex");
  return hash.slice(0, 8).toUpperCase();
}

export function parseMobileApprovalCommand(content) {
  const match = String(content ?? "").normalize("NFKC").trim().match(commandPattern);
  if (!match) return null;
  return {
    decision: match[1] === "批准" ? "approved" : "rejected",
    code: match[2],
  };
}

export function mobileApprovalNotification(task, { expiresAt }) {
  const code = mobileApprovalCode(task);
  const source = boundedText(task.payload?.content, 320) || "（原消息不可用）";
  const reply = boundedText(task.result?.reply, 800) || "（草稿为空）";
  return {
    code,
    draftSha256: taskDraftSha256(task),
    text: [
      "## Foursday 待审批回复",
      `原消息：${source}`,
      `拟回复：${reply}`,
      `风险：${boundedText(task.result?.riskLevel, 20) || "未标注"}`,
      `有效期：${expiresAt.toISOString()}`,
      "请在此会话单独回复以下一行之一：",
      `批准 ${code}`,
      `拒绝 ${code}`,
      "草稿变化、人工已回复、过期或重复操作都会使本指令失效。",
    ].join("\n\n"),
  };
}

function draftExpiry(task, ttlMs) {
  const readyAt = new Date(task.draft_ready_at ?? task.updated_at).getTime();
  if (!Number.isFinite(readyAt)) return null;
  return new Date(readyAt + ttlMs);
}

function actionable(task, now, ttlMs) {
  if (task?.status !== "awaiting_approval" || !task?.result?.reply) return false;
  const expiresAt = draftExpiry(task, ttlMs);
  return expiresAt != null && expiresAt > now;
}

async function pendingApprovalTasks(store) {
  const tasks = await store.listTasks({ status: "awaiting_approval", limit: 101 });
  if (tasks.length > 100) {
    throw new Error("Mobile approval queue exceeds the safe limit");
  }
  return tasks;
}

export async function notifyPendingMobileApprovals({ store, dws, config, now = new Date() }) {
  if (!config.mobileApprovalEnabled) return { inspected: 0, sent: 0 };
  const tasks = await pendingApprovalTasks(store);
  let sent = 0;
  for (const task of tasks) {
    if (!actionable(task, now, config.draftApprovalTtlMs)) continue;
    const notification = mobileApprovalNotification(task, {
      expiresAt: draftExpiry(task, config.draftApprovalTtlMs),
    });
    const key = `${checkpointPrefix}${task.id}:${task.approval_version}:${notification.code}`;
    if (await store.getCheckpoint(key)) continue;
    const receipt = await dws.sendMobileApproval({
      selfUserId: config.selfUserId,
      text: notification.text,
      idempotencyKey: `mobile-approval-${createHash("sha256").update(key).digest("hex")}`,
    });
    await dws.verifySendReceipt(receipt);
    await store.setCheckpoint(key, JSON.stringify({
      sentAt: now.toISOString(),
      draftSha256: notification.draftSha256,
    }), now);
    sent += 1;
  }
  return { inspected: tasks.length, sent };
}

export async function processMobileApprovalCommands({ store, dws, config, now = new Date() }) {
  if (!config.mobileApprovalEnabled) return { fetched: 0, decided: 0, bootstrapped: false };
  const previous = await store.getCheckpoint(commandCheckpoint);
  if (!previous) {
    await store.setCheckpoint(commandCheckpoint, now.toISOString(), now);
    return { fetched: 0, decided: 0, bootstrapped: true };
  }
  const previousTime = new Date(previous).getTime();
  if (!Number.isFinite(previousTime)) {
    throw new Error("Mobile approval command checkpoint is invalid");
  }
  const start = new Date(Math.max(0, previousTime - 10 * 60 * 1_000));
  const messages = await dws.fetchMobileApprovalMessages({
    selfUserId: config.selfUserId,
    start,
    end: now,
  });
  let decided = 0;
  for (const message of messages) {
    if (message.approvalOwnerVerified !== true) continue;
    const command = parseMobileApprovalCommand(message.content);
    if (!command) continue;
    const tasks = await pendingApprovalTasks(store);
    const matches = tasks.filter((task) =>
      actionable(task, now, config.draftApprovalTtlMs) &&
      mobileApprovalCode(task) === command.code
    );
    if (matches.length !== 1) continue;
    const task = matches[0];
    await store.decideTask(task.id, {
      decision: command.decision,
      actor: "dingtalk-mobile",
      reason: "owner_mobile_approval",
      expectedDraftSha256: taskDraftSha256(task),
    }, now);
    decided += 1;
  }
  await store.setCheckpoint(commandCheckpoint, now.toISOString(), now);
  return { fetched: messages.length, decided, bootstrapped: false };
}

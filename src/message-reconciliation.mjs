const checkpointKey = "reconciliation:message-coverage:last-success";
const failureCheckpointKey = "reconciliation:message-coverage:last-failure";

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function deduplicate(messages) {
  const byId = new Map();
  for (const message of messages) {
    if (!message?.id) continue;
    byId.set(String(message.id), message);
  }
  return [...byId.values()].sort(
    (left, right) => new Date(left.createTime).getTime() - new Date(right.createTime).getTime(),
  );
}

export function normalizeMessageCoverage(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const numericFields = [
    "sourceMessages",
    "missedBeforeRepair",
    "repairedMessages",
    "remainingMissing",
  ];
  if (numericFields.some((field) => !finiteNonNegative(value[field]))) return null;
  if (value.missedBeforeRepair > value.sourceMessages) return null;
  if (value.repairedMessages > value.missedBeforeRepair) return null;
  const denominator = value.sourceMessages;
  return {
    checkedAt: new Date(value.checkedAt).toString() === "Invalid Date"
      ? null
      : new Date(value.checkedAt).toISOString(),
    windowStart: new Date(value.windowStart).toString() === "Invalid Date"
      ? null
      : new Date(value.windowStart).toISOString(),
    windowEnd: new Date(value.windowEnd).toString() === "Invalid Date"
      ? null
      : new Date(value.windowEnd).toISOString(),
    dataComplete: value.dataComplete === true,
    sourceMessages: value.sourceMessages,
    missedBeforeRepair: value.missedBeforeRepair,
    observedMissRate: denominator === 0 ? null : value.missedBeforeRepair / denominator,
    repairedMessages: value.repairedMessages,
    remainingMissing: value.remainingMissing,
    finalMissRate: denominator === 0 ? null : value.remainingMissing / denominator,
    targetRate: 0.001,
    targetMet:
      value.dataComplete === true && denominator > 0
        ? value.missedBeforeRepair / denominator < 0.001
        : null,
  };
}

export async function reconcileMessageCoverage({
  config,
  store,
  dws,
  now = new Date(),
}) {
  const windowEnd = new Date(now.getTime() - config.reconciliationGraceMs);
  const windowStart = new Date(windowEnd.getTime() - config.reconciliationWindowMs);
  try {
    const batches = await Promise.all([
      ...config.targetUserIds.map((senderUserId) => dws.fetchBySender({
        senderUserId,
        start: windowStart,
        end: windowEnd,
      })),
      ...config.targetGroupIds.map((groupId) => dws.fetchGroupMentions({
        groupIds: [groupId],
        start: windowStart,
        end: windowEnd,
      })),
    ]);
    const allMessages = deduplicate(batches.flat());
    const dataComplete = allMessages.length <= config.reconciliationLimit;
    const messages = dataComplete
      ? allMessages
      : allMessages.slice(-config.reconciliationLimit);
    const ids = messages.map((message) => String(message.id));
    const knownBefore = await store.knownMessageIds(ids);
    const missing = messages.filter((message) => !knownBefore.has(String(message.id)));
    if (missing.length > 0) await store.ingestMessages(missing, now);
    const knownAfter = await store.knownMessageIds(ids);
    const remainingMissing = ids.filter((id) => !knownAfter.has(id)).length;
    const repairedMessages = missing.filter((message) =>
      knownAfter.has(String(message.id))).length;
    const report = {
      checkedAt: now.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dataComplete,
      sourceMessages: messages.length,
      missedBeforeRepair: missing.length,
      repairedMessages,
      remainingMissing,
    };
    await store.setCheckpoint(checkpointKey, JSON.stringify(report), now);
    return normalizeMessageCoverage(report);
  } catch (error) {
    await store.setCheckpoint(failureCheckpointKey, "source_read_failed", now);
    throw error;
  }
}

export const messageCoverageCheckpointKey = checkpointKey;

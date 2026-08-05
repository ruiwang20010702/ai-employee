import { createHash } from "node:crypto";

export function decisionSha256(result = {}) {
  return createHash("sha256").update(JSON.stringify({
    shouldReply: result?.shouldReply,
    riskLevel: result?.riskLevel,
    decisionSource: result?.decisionSource,
    decisionKind: result?.decisionKind,
  })).digest("hex");
}

export function evaluateDecisionQuality(
  reviews,
  { minimumSamples = 100, minimumNoReplyAccuracy = 0.95 } = {},
) {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples <= 0) {
    throw new Error("minimumSamples must be a positive integer");
  }
  if (
    !Number.isFinite(minimumNoReplyAccuracy) ||
    minimumNoReplyAccuracy < 0 ||
    minimumNoReplyAccuracy > 1
  ) {
    throw new Error("minimumNoReplyAccuracy must be between 0 and 1");
  }
  const valid = reviews.filter(
    (review) =>
      typeof review.predictedShouldReply === "boolean" &&
      typeof review.expectedShouldReply === "boolean" &&
      review.decisionCurrent !== false,
  );
  const correct = valid.filter(
    (review) => review.predictedShouldReply === review.expectedShouldReply,
  ).length;
  const predictedNoReply = valid.filter(
    (review) => review.predictedShouldReply === false,
  );
  const correctNoReply = predictedNoReply.filter(
    (review) => review.expectedShouldReply === false,
  ).length;
  const highRiskFalseReplyRecommendations = valid.filter(
    (review) =>
      review.predictedShouldReply === true &&
      review.expectedShouldReply === false &&
      review.riskLevel === "high",
  ).length;
  const accuracy = valid.length === 0 ? null : correct / valid.length;
  const noReplyAccuracy = predictedNoReply.length === 0
    ? null
    : correctNoReply / predictedNoReply.length;
  const gates = {
    enoughSamples: valid.length >= minimumSamples,
    noReplyAccuracy:
      noReplyAccuracy != null && noReplyAccuracy >= minimumNoReplyAccuracy,
    noHighRiskFalseReplyRecommendations:
      highRiskFalseReplyRecommendations === 0,
  };
  return {
    reviewed: valid.length,
    correct,
    accuracy,
    predictedNoReply: predictedNoReply.length,
    correctNoReply,
    noReplyAccuracy,
    highRiskFalseReplyRecommendations,
    thresholds: { minimumSamples, minimumNoReplyAccuracy },
    gates,
    accepted: Object.values(gates).every(Boolean),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function summarizeSlice(reviews) {
  const valid = reviews.filter(
    (review) =>
      typeof review.predictedShouldReply === "boolean" &&
      typeof review.expectedShouldReply === "boolean" &&
      review.decisionCurrent !== false,
  );
  const correct = valid.filter(
    (review) => review.predictedShouldReply === review.expectedShouldReply,
  ).length;
  const predictedNoReply = valid.filter(
    (review) => review.predictedShouldReply === false,
  );
  const falseReplyRecommendations = valid.filter(
    (review) =>
      review.predictedShouldReply === true &&
      review.expectedShouldReply === false,
  ).length;
  const missedReplyNeeds = valid.filter(
    (review) =>
      review.predictedShouldReply === false &&
      review.expectedShouldReply === true,
  ).length;
  return {
    reviewed: valid.length,
    accuracy: ratio(correct, valid.length),
    noReplyAccuracy: ratio(
      predictedNoReply.filter(
        (review) => review.expectedShouldReply === false,
      ).length,
      predictedNoReply.length,
    ),
    falseReplyRecommendations,
    missedReplyNeeds,
    highRiskFalseReplyRecommendations: valid.filter(
      (review) =>
        review.predictedShouldReply === true &&
        review.expectedShouldReply === false &&
        review.riskLevel === "high",
    ).length,
  };
}

function grouped(reviews, dimension, labelFor) {
  const groups = new Map();
  for (const review of reviews) {
    const label = String(labelFor(review) ?? "未知").trim() || "未知";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(review);
  }
  return [...groups.entries()]
    .map(([label, values]) => ({
      dimension,
      label,
      ...summarizeSlice(values),
    }))
    .sort((left, right) =>
      right.reviewed - left.reviewed || left.label.localeCompare(right.label, "zh-CN"),
    );
}

function decisionAttributes(record, groups) {
  const conversationId = record.conversation_id ?? record.conversationId;
  return {
    taskId: record.taskId ?? record.id,
    prediction:
      (record.result?.shouldReply ?? record.predictedShouldReply) === true
        ? "应回复"
        : "不应回复",
    chatType: groups.has(String(conversationId)) ? "群聊" : "私聊",
    source: String(
      record.result?.decisionSource ?? record.decisionSource ?? "未知",
    ),
  };
}

export function evaluateDecisionReviewCoverage(
  tasks,
  reviews,
  { targetGroupIds = [], minimumSamples = 100 } = {},
) {
  const groups = new Set(targetGroupIds.map(String));
  const records = new Map();
  for (const record of [...tasks, ...reviews]) {
    const attributes = decisionAttributes(record, groups);
    if (attributes.taskId) records.set(String(attributes.taskId), attributes);
  }
  const currentReviews = reviews.filter(
    (review) => review.decisionCurrent !== false,
  );
  const reviewedIds = new Set(currentReviews.map((review) => String(review.taskId)));
  const desired = {
    "判断类别": Math.max(1, Math.ceil(minimumSamples * 0.1)),
    "会话类型": Math.max(1, Math.ceil(minimumSamples * 0.1)),
    "判断来源": Math.max(1, Math.ceil(minimumSamples * 0.05)),
  };
  const dimensions = [
    ["判断类别", "prediction"],
    ["会话类型", "chatType"],
    ["判断来源", "source"],
  ];
  const rows = [];
  for (const [dimension, key] of dimensions) {
    const labels = [...new Set([...records.values()].map((record) => record[key]))]
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    for (const label of labels) {
      const eligibleIds = [...records.values()]
        .filter((record) => record[key] === label)
        .map((record) => String(record.taskId));
      const eligible = eligibleIds.length;
      const required = Math.min(eligible, desired[dimension]);
      const reviewed = eligibleIds.filter((id) => reviewedIds.has(id)).length;
      rows.push({
        dimension,
        label,
        eligible,
        reviewed,
        required,
        passed: required > 0 && reviewed >= required,
      });
    }
  }
  return {
    rows,
    accepted: rows.length > 0 && rows.every((row) => row.passed),
  };
}

export function evaluateDecisionQualityBreakdown(
  reviews,
  { targetGroupIds = [] } = {},
) {
  const groups = new Set(targetGroupIds.map(String));
  const chatType = (review) =>
    groups.has(String(review.conversationId)) ? "群聊" : "私聊";
  return [
    ...grouped(reviews, "会话类型", chatType),
    ...grouped(
      reviews,
      "联系人或群",
      (review) => chatType(review) === "群聊"
        ? `群聊：${review.conversationId ?? "未知"}`
        : `私聊：${review.senderName ?? review.senderUserId ?? "未知"}`,
    ),
    ...grouped(
      reviews,
      "判断来源",
      (review) => review.decisionSource ?? "未知",
    ),
  ];
}

export function buildDecisionReviewQueue(
  tasks,
  reviews,
  { targetGroupIds = [], limit = 50 } = {},
) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("Review queue limit must be between 1 and 500");
  }
  const reviewed = new Set(
    reviews
      .filter((review) => review.decisionCurrent !== false)
      .map((review) => review.taskId),
  );
  const groups = new Set(targetGroupIds.map(String));
  const candidates = tasks
    .filter(
      (task) =>
        typeof task.result?.shouldReply === "boolean" &&
        !reviewed.has(task.id),
    )
    .map((task) => {
      const reasons = [];
      let priority = 0;
      if (task.result.riskLevel === "high") {
        priority += 100;
        reasons.push("高风险判断");
      }
      if (task.result.decisionSource === "model") {
        priority += 50;
        reasons.push("模型判断");
      }
      if (groups.has(String(task.conversation_id))) {
        priority += 30;
        reasons.push("群聊样本");
      }
      if (task.result.shouldReply === false) {
        priority += 20;
        reasons.push("不回复判断");
      }
      if (reasons.length === 0) reasons.push("补充覆盖");
      return { task, priority, priorityReasons: reasons };
    })
    .sort((left, right) =>
      right.priority - left.priority ||
      new Date(right.task.updated_at).getTime() -
        new Date(left.task.updated_at).getTime(),
    );
  const reviewedByStratum = new Map();
  for (const review of reviews.filter((item) => item.decisionCurrent !== false)) {
    const attributes = decisionAttributes(review, groups);
    const key = `${attributes.chatType}\n${attributes.prediction}\n${attributes.source}`;
    reviewedByStratum.set(key, (reviewedByStratum.get(key) ?? 0) + 1);
  }
  const selected = [];
  const selectedIds = new Set();
  const selectedByStratum = new Map();
  const takeRisk = () => {
    const item = candidates.find(({ task }) => !selectedIds.has(task.id));
    if (!item) return false;
    selected.push({ ...item, selectionKind: "risk" });
    selectedIds.add(item.task.id);
    const attributes = decisionAttributes(item.task, groups);
    const key = `${attributes.chatType}\n${attributes.prediction}\n${attributes.source}`;
    selectedByStratum.set(key, (selectedByStratum.get(key) ?? 0) + 1);
    return true;
  };
  const takeCoverage = () => {
    const remaining = candidates.filter(({ task }) => !selectedIds.has(task.id));
    if (remaining.length === 0) return false;
    remaining.sort((left, right) => {
      const leftAttributes = decisionAttributes(left.task, groups);
      const rightAttributes = decisionAttributes(right.task, groups);
      const leftKey = `${leftAttributes.chatType}\n${leftAttributes.prediction}\n${leftAttributes.source}`;
      const rightKey = `${rightAttributes.chatType}\n${rightAttributes.prediction}\n${rightAttributes.source}`;
      const leftCount = (reviewedByStratum.get(leftKey) ?? 0) +
        (selectedByStratum.get(leftKey) ?? 0);
      const rightCount = (reviewedByStratum.get(rightKey) ?? 0) +
        (selectedByStratum.get(rightKey) ?? 0);
      return leftCount - rightCount || right.priority - left.priority ||
        String(left.task.id).localeCompare(String(right.task.id));
    });
    const item = remaining[0];
    const attributes = decisionAttributes(item.task, groups);
    const key = `${attributes.chatType}\n${attributes.prediction}\n${attributes.source}`;
    selectedByStratum.set(key, (selectedByStratum.get(key) ?? 0) + 1);
    selected.push({
      ...item,
      selectionKind: "coverage",
      priorityReasons: [...item.priorityReasons, "覆盖抽样"],
    });
    selectedIds.add(item.task.id);
    return true;
  };
  while (selected.length < Math.min(limit, candidates.length)) {
    const take = selected.length % 2 === 0 ? takeRisk : takeCoverage;
    if (!take()) break;
  }
  return selected;
}

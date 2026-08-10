import { createHash } from "node:crypto";

const responseReasonLabels = Object.freeze({
  missed_request: "遗漏明确请求",
  closed_loop: "闭环消息误触发",
  group_trigger: "群聊触发错误",
  manual_replied: "人工已经回复",
  context_error: "上下文判断错误",
  capability_boundary: "能力边界判断错误",
  other: "其他",
  legacy_unstructured: "历史未结构化原因",
});

const draftAssessmentLabels = Object.freeze({
  usable: "可直接使用",
  needs_revision: "需要修改",
  unsafe: "不安全",
});

const draftReasonLabels = Object.freeze({
  wrong_context: "上下文理解错误",
  wrong_recipient: "回复对象错误",
  fact_error: "事实或信息错误",
  incomplete: "遗漏关键信息",
  tone_format: "语气或格式不合适",
  unsafe_claim: "存在越权、承诺或不安全表述",
  other: "其他",
});

function metadataCode(note, key) {
  return String(note ?? "").match(
    new RegExp(`\\[${key}:([a-z_]+)\\]`, "u"),
  )?.[1] ?? null;
}

function metadataSha256(note, key) {
  return String(note ?? "").match(
    new RegExp(`\\[${key}:([a-f0-9]{64})\\]`, "u"),
  )?.[1] ?? null;
}

export function parseDecisionReviewReason(note) {
  const value = String(note ?? "").trim();
  const code = metadataCode(value, "response_reason") ?? metadataCode(value, "reason");
  if (code && Object.hasOwn(responseReasonLabels, code) && code !== "legacy_unstructured") {
    return { code, label: responseReasonLabels[code] };
  }
  return value
    ? { code: "legacy_unstructured", label: responseReasonLabels.legacy_unstructured }
    : null;
}

export function parseDraftAssessment(note) {
  const code = metadataCode(note, "draft");
  return code && Object.hasOwn(draftAssessmentLabels, code)
    ? { code, label: draftAssessmentLabels[code] }
    : null;
}

export function parseDraftIssueReason(note) {
  const code = metadataCode(note, "draft_reason");
  return code && Object.hasOwn(draftReasonLabels, code)
    ? { code, label: draftReasonLabels[code] }
    : null;
}

export function parseDraftSha256(note) {
  return metadataSha256(note, "draft_sha256");
}

export function draftSha256(draft = "") {
  return createHash("sha256").update(String(draft ?? "")).digest("hex");
}

export function formatDecisionReviewMetadata({
  responseReasonCode = null,
  draftAssessment = null,
  draftReasonCode = null,
  reviewedDraftSha256 = null,
  detail = "",
} = {}) {
  if (
    responseReasonCode != null &&
    (!Object.hasOwn(responseReasonLabels, responseReasonCode) || responseReasonCode === "legacy_unstructured")
  ) throw new Error("invalid response review reason");
  if (
    draftAssessment != null &&
    !Object.hasOwn(draftAssessmentLabels, draftAssessment)
  ) throw new Error("invalid draft assessment");
  if (
    draftReasonCode != null &&
    !Object.hasOwn(draftReasonLabels, draftReasonCode)
  ) throw new Error("invalid draft issue reason");
  if (draftReasonCode && !["needs_revision", "unsafe"].includes(draftAssessment)) {
    throw new Error("draft issue reason requires a non-usable assessment");
  }
  if (["needs_revision", "unsafe"].includes(draftAssessment) && !draftReasonCode) {
    throw new Error("non-usable draft assessment requires a reason");
  }
  if (
    reviewedDraftSha256 != null &&
    !/^[a-f0-9]{64}$/u.test(String(reviewedDraftSha256))
  ) throw new Error("invalid reviewed draft sha256");
  if (draftAssessment && !reviewedDraftSha256) {
    throw new Error("draft assessment requires a reviewed draft sha256");
  }
  if (reviewedDraftSha256 && !draftAssessment) {
    throw new Error("reviewed draft sha256 requires a draft assessment");
  }
  const text = String(detail ?? "").trim();
  if (text.length > 500) throw new Error("review detail is too long");
  const tokens = [];
  if (responseReasonCode) tokens.push(`[response_reason:${responseReasonCode}]`);
  if (draftAssessment) tokens.push(`[draft:${draftAssessment}]`);
  if (draftReasonCode) tokens.push(`[draft_reason:${draftReasonCode}]`);
  if (reviewedDraftSha256) tokens.push(`[draft_sha256:${reviewedDraftSha256}]`);
  return `${tokens.join("")}${text ? ` ${text}` : ""}`;
}

export function createStructuredDecisionReviewNote({
  predictedShouldReply,
  expectedShouldReply,
  draft = "",
  responseReasonCode = null,
  draftAssessment = null,
  draftReasonCode = null,
  detail = "",
} = {}) {
  if (
    typeof predictedShouldReply !== "boolean" ||
    typeof expectedShouldReply !== "boolean"
  ) throw new Error("reply decisions must be boolean");
  const disagrees = predictedShouldReply !== expectedShouldReply;
  if (disagrees && !responseReasonCode) {
    throw new Error("response disagreement requires a reason");
  }
  if (!disagrees && responseReasonCode) {
    throw new Error("response reason is only valid for a disagreement");
  }
  const normalizedDraft = String(draft ?? "");
  const needsDraftAssessment =
    predictedShouldReply === true &&
    expectedShouldReply === true &&
    normalizedDraft.trim().length > 0;
  if (needsDraftAssessment && !draftAssessment) {
    throw new Error("matching reply decision requires a draft assessment");
  }
  if (!needsDraftAssessment && (draftAssessment || draftReasonCode)) {
    throw new Error("draft assessment is not applicable");
  }
  return formatDecisionReviewMetadata({
    responseReasonCode,
    draftAssessment,
    draftReasonCode,
    reviewedDraftSha256:
      needsDraftAssessment ? draftSha256(normalizedDraft) : null,
    detail,
  });
}

function draftAssessmentApplicable(review) {
  if (
    review?.predictedShouldReply !== true ||
    review?.expectedShouldReply !== true
  ) return false;
  return review.draftPresent !== false;
}

export function isDraftAssessmentCurrent(review) {
  const assessment = parseDraftAssessment(review?.note);
  if (!assessment) return false;
  const reviewedHash = parseDraftSha256(review?.note);
  const currentHash = review?.currentDraftSha256;
  return (
    typeof reviewedHash === "string" &&
    typeof currentHash === "string" &&
    reviewedHash === currentHash
  );
}

export function isDecisionResponseReviewUsable(review) {
  if (
    review?.decisionCurrent === false ||
    typeof review?.predictedShouldReply !== "boolean" ||
    typeof review?.expectedShouldReply !== "boolean"
  ) return false;
  if (review.predictedShouldReply === review.expectedShouldReply) return true;
  const reason = parseDecisionReviewReason(review.note);
  return reason != null && reason.code !== "legacy_unstructured";
}

export function isDecisionReviewComplete(review) {
  if (!isDecisionResponseReviewUsable(review)) return false;
  if (draftAssessmentApplicable(review)) {
    return isDraftAssessmentCurrent(review);
  }
  return true;
}

export function summarizeDecisionDisagreementReasons(reviews) {
  const counts = new Map();
  for (const review of reviews) {
    if (
      review.decisionCurrent === false ||
      typeof review.predictedShouldReply !== "boolean" ||
      typeof review.expectedShouldReply !== "boolean" ||
      review.predictedShouldReply === review.expectedShouldReply
    ) continue;
    const reason = parseDecisionReviewReason(review.note) ?? {
      code: "legacy_unstructured",
      label: responseReasonLabels.legacy_unstructured,
    };
    const current = counts.get(reason.code) ?? { ...reason, count: 0 };
    current.count += 1;
    counts.set(reason.code, current);
  }
  return [...counts.values()].sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"),
  );
}

export function summarizeDraftQuality(reviews) {
  const assessments = reviews
    .filter((review) =>
      review.decisionCurrent !== false &&
      draftAssessmentApplicable(review) &&
      isDraftAssessmentCurrent(review),
    )
    .map((review) => ({
      assessment: parseDraftAssessment(review.note),
      reason: parseDraftIssueReason(review.note),
    }))
    .filter((item) => item.assessment != null);
  const count = (code) => assessments.filter(
    (item) => item.assessment.code === code,
  ).length;
  const reasons = new Map();
  for (const item of assessments) {
    if (!item.reason) continue;
    const current = reasons.get(item.reason.code) ?? { ...item.reason, count: 0 };
    current.count += 1;
    reasons.set(item.reason.code, current);
  }
  const usable = count("usable");
  return {
    reviewed: assessments.length,
    usable,
    needsRevision: count("needs_revision"),
    unsafe: count("unsafe"),
    usabilityRate: ratio(usable, assessments.length),
    reasons: [...reasons.values()].sort(
      (left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"),
    ),
  };
}

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
  {
    minimumSamples = 100,
    minimumReplyAccuracy = 0.95,
    minimumNoReplyAccuracy = 0.95,
    minimumDraftSamples = 30,
    minimumDraftUsability = 0.9,
  } = {},
) {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples <= 0) {
    throw new Error("minimumSamples must be a positive integer");
  }
  if (
    !Number.isFinite(minimumReplyAccuracy) ||
    minimumReplyAccuracy < 0 ||
    minimumReplyAccuracy > 1
  ) {
    throw new Error("minimumReplyAccuracy must be between 0 and 1");
  }
  if (
    !Number.isFinite(minimumNoReplyAccuracy) ||
    minimumNoReplyAccuracy < 0 ||
    minimumNoReplyAccuracy > 1
  ) {
    throw new Error("minimumNoReplyAccuracy must be between 0 and 1");
  }
  if (!Number.isSafeInteger(minimumDraftSamples) || minimumDraftSamples <= 0) {
    throw new Error("minimumDraftSamples must be a positive integer");
  }
  if (
    !Number.isFinite(minimumDraftUsability) ||
    minimumDraftUsability < 0 ||
    minimumDraftUsability > 1
  ) {
    throw new Error("minimumDraftUsability must be between 0 and 1");
  }
  const valid = reviews.filter(
    isDecisionResponseReviewUsable,
  );
  const draftQuality = summarizeDraftQuality(reviews);
  const correct = valid.filter(
    (review) => review.predictedShouldReply === review.expectedShouldReply,
  ).length;
  const predictedNoReply = valid.filter(
    (review) => review.predictedShouldReply === false,
  );
  const predictedReply = valid.filter(
    (review) => review.predictedShouldReply === true,
  );
  const correctReply = predictedReply.filter(
    (review) => review.expectedShouldReply === true,
  ).length;
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
  const replyAccuracy = predictedReply.length === 0
    ? null
    : correctReply / predictedReply.length;
  const noReplyAccuracy = predictedNoReply.length === 0
    ? null
    : correctNoReply / predictedNoReply.length;
  const gates = {
    enoughSamples: valid.length >= minimumSamples,
    replyAccuracy:
      replyAccuracy != null && replyAccuracy >= minimumReplyAccuracy,
    noReplyAccuracy:
      noReplyAccuracy != null && noReplyAccuracy >= minimumNoReplyAccuracy,
    noHighRiskFalseReplyRecommendations:
      highRiskFalseReplyRecommendations === 0,
    enoughDraftSamples: draftQuality.reviewed >= minimumDraftSamples,
    draftUsability:
      draftQuality.usabilityRate != null &&
      draftQuality.usabilityRate >= minimumDraftUsability,
    noUnsafeDrafts: draftQuality.unsafe === 0,
  };
  return {
    reviewed: valid.length,
    correct,
    accuracy,
    predictedReply: predictedReply.length,
    correctReply,
    replyAccuracy,
    predictedNoReply: predictedNoReply.length,
    correctNoReply,
    noReplyAccuracy,
    highRiskFalseReplyRecommendations,
    thresholds: {
      minimumSamples,
      minimumReplyAccuracy,
      minimumNoReplyAccuracy,
      minimumDraftSamples,
      minimumDraftUsability,
    },
    draftQuality,
    gates,
    accepted: Object.values(gates).every(Boolean),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function summarizeSlice(reviews) {
  const valid = reviews.filter(isDecisionResponseReviewUsable);
  const correct = valid.filter(
    (review) => review.predictedShouldReply === review.expectedShouldReply,
  ).length;
  const predictedNoReply = valid.filter(
    (review) => review.predictedShouldReply === false,
  );
  const predictedReply = valid.filter(
    (review) => review.predictedShouldReply === true,
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
    replyAccuracy: ratio(
      predictedReply.filter(
        (review) => review.expectedShouldReply === true,
      ).length,
      predictedReply.length,
    ),
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
    const prediction = record.result?.shouldReply ?? record.predictedShouldReply;
    if (typeof prediction !== "boolean") continue;
    const attributes = decisionAttributes(record, groups);
    if (attributes.taskId) records.set(String(attributes.taskId), attributes);
  }
  const currentReviews = reviews.filter(isDecisionResponseReviewUsable);
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

export function evaluateDecisionQualityDiagnostics(
  reviews,
  { targetGroupIds = [] } = {},
) {
  const groups = new Set(targetGroupIds.map(String));
  const chatType = (review) =>
    groups.has(String(review.conversationId)) ? "群聊" : "私聊";
  return [
    ...grouped(
      reviews,
      "判断类别",
      (review) => review.predictedShouldReply === true ? "应回复" : "不应回复",
    ),
    ...grouped(reviews, "会话类型", chatType),
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
  const currentByTask = new Map(
    reviews
      .filter((review) => review.decisionCurrent !== false)
      .map((review) => [review.taskId, review]),
  );
  const reviewed = new Set(
    reviews
      .filter(isDecisionReviewComplete)
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
      const existingReview = currentByTask.get(task.id);
      if (existingReview && !isDecisionResponseReviewUsable(existingReview)) {
        priority += 150;
        reasons.push("重新确认历史分歧");
      } else if (existingReview && !isDecisionReviewComplete(existingReview)) {
        priority += 120;
        reasons.push("补充草稿评价");
      }
      if (task.result.riskLevel === "high") {
        priority += 100;
        reasons.push("高风险判断");
      }
      if (["codex", "model"].includes(task.result.decisionSource)) {
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
      return { task, existingReview, priority, priorityReasons: reasons };
    })
    .sort((left, right) =>
      right.priority - left.priority ||
      new Date(right.task.updated_at).getTime() -
        new Date(left.task.updated_at).getTime(),
    );
  const reviewedByStratum = new Map();
  for (const review of reviews.filter(isDecisionReviewComplete)) {
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

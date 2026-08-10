import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDecisionReviewQueue,
  createStructuredDecisionReviewNote,
  draftSha256,
  evaluateDecisionQuality,
  evaluateDecisionQualityBreakdown,
  evaluateDecisionQualityDiagnostics,
  evaluateDecisionReviewCoverage,
  formatDecisionReviewMetadata,
  isDecisionReviewComplete,
  isDecisionResponseReviewUsable,
  isDraftAssessmentCurrent,
  parseDecisionReviewReason,
  parseDraftAssessment,
  parseDraftIssueReason,
  parseDraftSha256,
  summarizeDecisionDisagreementReasons,
  summarizeDraftQuality,
} from "../src/decision-quality.mjs";

const reviewedDraft = "测试回复草稿";
const reviewedDraftHash = draftSha256(reviewedDraft);

function draftNote(assessment = "usable", reason = null, detail = "") {
  return formatDecisionReviewMetadata({
    draftAssessment: assessment,
    draftReasonCode: reason,
    reviewedDraftSha256: reviewedDraftHash,
    detail,
  });
}

test("影子质量报告计算不回复准确率和放量门槛", () => {
  const reviews = Array.from({ length: 100 }, (_, index) => ({
    predictedShouldReply: index >= 50,
    expectedShouldReply: index < 2 ? true : index >= 50,
    riskLevel: "low",
    draftPresent: index >= 50,
    currentDraftSha256: index >= 50 ? reviewedDraftHash : draftSha256(""),
    note: index < 2
      ? "[response_reason:missed_request]"
      : index >= 50
        ? draftNote()
        : "",
  }));
  const report = evaluateDecisionQuality(reviews);
  assert.equal(report.reviewed, 100);
  assert.equal(report.predictedNoReply, 50);
  assert.equal(report.correctNoReply, 48);
  assert.equal(report.replyAccuracy, 1);
  assert.equal(report.noReplyAccuracy, 0.96);
  assert.equal(report.draftQuality.reviewed, 50);
  assert.equal(report.draftQuality.usabilityRate, 1);
  assert.equal(report.accepted, true);
});

test("质量报告按会话、对象和判断来源拆分误判", () => {
  const reviews = [
    {
      taskId: "1",
      predictedShouldReply: false,
      expectedShouldReply: true,
      riskLevel: "low",
      decisionSource: "model",
      senderName: "甲",
      senderUserId: "u1",
      conversationId: "direct-1",
      note: "[response_reason:missed_request]",
    },
    {
      taskId: "2",
      predictedShouldReply: true,
      expectedShouldReply: false,
      riskLevel: "high",
      decisionSource: "hard-rule",
      senderName: "乙",
      senderUserId: "u2",
      conversationId: "group-1",
      note: "[response_reason:closed_loop]",
    },
  ];
  const report = evaluateDecisionQualityBreakdown(reviews, {
    targetGroupIds: ["group-1"],
  });
  const direct = report.find(
    (row) => row.dimension === "会话类型" && row.label === "私聊",
  );
  const group = report.find(
    (row) => row.dimension === "会话类型" && row.label === "群聊",
  );
  assert.equal(direct.missedReplyNeeds, 1);
  assert.equal(direct.replyAccuracy, null);
  assert.equal(group.falseReplyRecommendations, 1);
  assert.equal(group.replyAccuracy, 0);
  assert.equal(group.highRiskFalseReplyRecommendations, 1);
  assert.equal(
    report.some(
      (row) => row.dimension === "判断来源" && row.label === "model",
    ),
    true,
  );
});

test("命令行质量诊断只输出判断类别、会话类型和来源聚合", () => {
  const diagnostics = evaluateDecisionQualityDiagnostics([
    {
      taskId: "1",
      predictedShouldReply: false,
      expectedShouldReply: true,
      riskLevel: "low",
      decisionSource: "codex",
      senderName: "不应出现在诊断中",
      senderUserId: "sensitive-user-id",
      conversationId: "direct-1",
      note: "[response_reason:missed_request]",
    },
    {
      taskId: "2",
      predictedShouldReply: true,
      expectedShouldReply: false,
      riskLevel: "high",
      decisionSource: "hard-rule",
      senderName: "另一个姓名",
      conversationId: "group-1",
      note: "[response_reason:closed_loop]",
    },
  ], { targetGroupIds: ["group-1"] });

  assert.deepEqual(
    [...new Set(diagnostics.map((row) => row.dimension))],
    ["判断类别", "会话类型", "判断来源"],
  );
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("不应出现在诊断中"), false);
  assert.equal(serialized.includes("sensitive-user-id"), false);
  assert.equal(serialized.includes("direct-1"), false);
  assert.equal(serialized.includes("group-1"), false);
  assert.equal(
    diagnostics.find(
      (row) => row.dimension === "判断来源" && row.label === "codex",
    ).missedReplyNeeds,
    1,
  );
});

test("分歧原因诊断只输出结构化类别和数量", () => {
  const reviews = [
    {
      predictedShouldReply: true,
      expectedShouldReply: false,
      decisionCurrent: true,
      note: "[reason:closed_loop] 真实消息内容不应出现在报告中",
    },
    {
      predictedShouldReply: true,
      expectedShouldReply: false,
      decisionCurrent: true,
      note: "一条历史自由文本原因",
    },
    {
      predictedShouldReply: false,
      expectedShouldReply: false,
      decisionCurrent: true,
      note: "",
    },
  ];
  assert.deepEqual(parseDecisionReviewReason(reviews[0].note), {
    code: "closed_loop",
    label: "闭环消息误触发",
  });
  const summary = summarizeDecisionDisagreementReasons(reviews);
  assert.deepEqual(summary, [
    { code: "closed_loop", label: "闭环消息误触发", count: 1 },
    { code: "legacy_unstructured", label: "历史未结构化原因", count: 1 },
  ]);
  assert.equal(JSON.stringify(summary).includes("真实消息内容"), false);
  assert.equal(JSON.stringify(summary).includes("历史自由文本"), false);
});

test("回应必要性与草稿质量使用两个独立维度", () => {
  const note = draftNote(
    "needs_revision",
    "wrong_recipient",
    "补充内容不会进入聚合报告",
  );
  assert.deepEqual(parseDraftAssessment(note), {
    code: "needs_revision",
    label: "需要修改",
  });
  assert.deepEqual(parseDraftIssueReason(note), {
    code: "wrong_recipient",
    label: "回复对象错误",
  });
  assert.equal(parseDraftSha256(note), reviewedDraftHash);
  const summary = summarizeDraftQuality([{
    predictedShouldReply: true,
    expectedShouldReply: true,
    decisionCurrent: true,
    draftPresent: true,
    currentDraftSha256: reviewedDraftHash,
    note,
  }]);
  assert.equal(summary.reviewed, 1);
  assert.equal(summary.usabilityRate, 0);
  assert.deepEqual(summary.reasons, [
    { code: "wrong_recipient", label: "回复对象错误", count: 1 },
  ]);
  assert.equal(JSON.stringify(summary).includes("补充内容"), false);
});

test("草稿变化只让草稿评价失效并保留回应必要性标签", () => {
  const review = {
    taskId: "changed-draft",
    predictedShouldReply: true,
    expectedShouldReply: true,
    decisionCurrent: true,
    draftPresent: true,
    currentDraftSha256: draftSha256("已经修改的新草稿"),
    note: draftNote(),
  };
  assert.equal(isDecisionResponseReviewUsable(review), true);
  assert.equal(isDraftAssessmentCurrent(review), false);
  assert.equal(isDecisionReviewComplete(review), false);
  assert.equal(evaluateDecisionQuality([review]).reviewed, 1);
  assert.equal(evaluateDecisionQuality([review]).draftQuality.reviewed, 0);
  const queue = buildDecisionReviewQueue([{
    id: "changed-draft",
    conversation_id: "direct",
    result: {
      shouldReply: true,
      reply: "已经修改的新草稿",
      riskLevel: "low",
      decisionSource: "codex",
    },
    updated_at: "2026-08-10T00:00:00Z",
  }], [review]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].existingReview, review);
  assert.equal(queue[0].priorityReasons[0], "补充草稿评价");
});

test("没有实际草稿时只评价回应必要性", () => {
  const note = createStructuredDecisionReviewNote({
    predictedShouldReply: true,
    expectedShouldReply: true,
    draft: "   ",
  });
  const review = {
    predictedShouldReply: true,
    expectedShouldReply: true,
    decisionCurrent: true,
    draftPresent: false,
    currentDraftSha256: draftSha256("   "),
    note,
  };
  assert.equal(note, "");
  assert.equal(isDecisionResponseReviewUsable(review), true);
  assert.equal(isDecisionReviewComplete(review), true);
  assert.equal(evaluateDecisionQuality([review]).draftQuality.reviewed, 0);
});

test("旧版未绑定草稿哈希的草稿评价不会进入质量门槛", () => {
  const review = {
    predictedShouldReply: true,
    expectedShouldReply: true,
    decisionCurrent: true,
    draftPresent: true,
    currentDraftSha256: reviewedDraftHash,
    note: "[draft:usable]",
  };
  assert.equal(isDecisionResponseReviewUsable(review), true);
  assert.equal(isDecisionReviewComplete(review), false);
  assert.equal(summarizeDraftQuality([review]).reviewed, 0);
});

test("任何不安全草稿都会独立阻止放量", () => {
  const reviews = Array.from({ length: 100 }, (_, index) => ({
    predictedShouldReply: index < 30,
    expectedShouldReply: index < 30,
    riskLevel: "low",
    draftPresent: index < 30,
    currentDraftSha256: index < 30 ? reviewedDraftHash : draftSha256(""),
    note: index === 0
      ? draftNote("unsafe", "unsafe_claim")
      : index < 30
        ? draftNote()
        : "",
  }));
  const report = evaluateDecisionQuality(reviews);
  assert.equal(report.draftQuality.unsafe, 1);
  assert.equal(report.gates.noUnsafeDrafts, false);
  assert.equal(report.accepted, false);
});

test("历史自由文本分歧不污染准确率并重新进入复核队列", () => {
  const review = {
    taskId: "legacy",
    predictedShouldReply: true,
    expectedShouldReply: false,
    decisionCurrent: true,
    note: "其实应该回应，但草稿内容错了",
  };
  assert.equal(isDecisionResponseReviewUsable(review), false);
  assert.equal(isDecisionReviewComplete(review), false);
  assert.equal(evaluateDecisionQuality([review]).reviewed, 0);
  const queue = buildDecisionReviewQueue([{
    id: "legacy",
    conversation_id: "direct",
    result: { shouldReply: true, riskLevel: "low", decisionSource: "codex" },
    updated_at: "2026-08-06T00:00:00Z",
  }], [review]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].priorityReasons[0], "重新确认历史分歧");
});

test("人工复核队列优先高风险、模型和群聊且排除已标注任务", () => {
  const task = (id, result, conversation = "direct") => ({
    id,
    conversation_id: conversation,
    result,
    updated_at: `2026-08-05T00:00:0${id}.000Z`,
  });
  const queue = buildDecisionReviewQueue(
    [
      task("1", { shouldReply: true, riskLevel: "low", decisionSource: "hard-rule" }),
      task("2", { shouldReply: false, riskLevel: "high", decisionSource: "model" }, "group"),
      task("3", { shouldReply: false, riskLevel: "low", decisionSource: "codex" }),
    ],
    [{
      taskId: "1",
      predictedShouldReply: true,
      expectedShouldReply: true,
      decisionCurrent: true,
      draftPresent: true,
      currentDraftSha256: reviewedDraftHash,
      note: draftNote(),
    }],
    { targetGroupIds: ["group"] },
  );
  assert.deepEqual(queue.map((item) => item.task.id), ["2", "3"]);
  assert.deepEqual(
    queue[0].priorityReasons,
    ["高风险判断", "模型判断", "群聊样本", "不回复判断"],
  );
});

test("样本不足或高风险错误回复建议会阻止放量", () => {
  const report = evaluateDecisionQuality([{
    predictedShouldReply: true,
    expectedShouldReply: false,
    riskLevel: "high",
    note: "[response_reason:closed_loop]",
  }]);
  assert.equal(report.gates.enoughSamples, false);
  assert.equal(report.gates.replyAccuracy, false);
  assert.equal(report.gates.noReplyAccuracy, false);
  assert.equal(report.highRiskFalseReplyRecommendations, 1);
  assert.equal(report.accepted, false);
});

test("低风险误建议回复过多也会阻止放量", () => {
  const reviews = Array.from({ length: 100 }, (_, index) => ({
    predictedShouldReply: index < 20,
    expectedShouldReply: index < 18,
    riskLevel: "low",
    draftPresent: index < 18,
    currentDraftSha256: index < 18 ? reviewedDraftHash : draftSha256(""),
    note: index < 18
      ? draftNote()
      : index < 20
        ? "[response_reason:closed_loop]"
        : "",
  }));
  const report = evaluateDecisionQuality(reviews);
  assert.equal(report.replyAccuracy, 0.9);
  assert.equal(report.highRiskFalseReplyRecommendations, 0);
  assert.equal(report.gates.replyAccuracy, false);
  assert.equal(report.accepted, false);
});

test("旧判断版本的人工标签不参与质量计算并重新进入队列", () => {
  const stale = {
    taskId: "task-1",
    predictedShouldReply: false,
    expectedShouldReply: false,
    riskLevel: "low",
    decisionCurrent: false,
  };
  assert.equal(evaluateDecisionQuality([stale]).reviewed, 0);
  const queue = buildDecisionReviewQueue([{
    id: "task-1",
    conversation_id: "direct",
    result: { shouldReply: true, riskLevel: "low", decisionSource: "model" },
    updated_at: "2026-08-05T00:00:00Z",
  }], [stale]);
  assert.equal(queue.length, 1);
});

test("分层覆盖门槛分别约束判断类别、会话类型和判断来源", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => ({
    id: `task-${index}`,
    conversation_id: index < 20 ? "direct" : "group",
    result: {
      shouldReply: index % 2 === 0,
      decisionSource: index < 20 ? "model" : "hard-rule",
    },
  }));
  const reviews = tasks.slice(0, 10).concat(tasks.slice(20, 30)).map((task) => ({
    taskId: task.id,
    conversationId: task.conversation_id,
    predictedShouldReply: task.result.shouldReply,
    expectedShouldReply: task.result.shouldReply,
    decisionSource: task.result.decisionSource,
    decisionCurrent: true,
  }));
  const coverage = evaluateDecisionReviewCoverage(tasks, reviews, {
    targetGroupIds: ["group"],
    minimumSamples: 100,
  });
  assert.equal(coverage.accepted, true);
  assert.equal(
    coverage.rows.every((row) => row.reviewed >= row.required),
    true,
  );
});

test("尚未完成判断的运行中任务不污染分层覆盖", () => {
  const coverage = evaluateDecisionReviewCoverage(
    [
      {
        id: "completed",
        conversation_id: "direct",
        result: { shouldReply: true, decisionSource: "codex" },
      },
      {
        id: "running",
        conversation_id: "direct",
        result: null,
      },
    ],
    [{
      taskId: "completed",
      conversationId: "direct",
      predictedShouldReply: true,
      expectedShouldReply: true,
      decisionSource: "codex",
      decisionCurrent: true,
    }],
    { minimumSamples: 1 },
  );
  assert.equal(coverage.rows.some((row) => row.label === "未知"), false);
  assert.equal(coverage.accepted, true);
});

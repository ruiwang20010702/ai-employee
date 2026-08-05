import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDecisionReviewQueue,
  evaluateDecisionQuality,
  evaluateDecisionQualityBreakdown,
  evaluateDecisionReviewCoverage,
} from "../src/decision-quality.mjs";

test("影子质量报告计算不回复准确率和放量门槛", () => {
  const reviews = Array.from({ length: 100 }, (_, index) => ({
    predictedShouldReply: index >= 50,
    expectedShouldReply: index < 2 ? true : index >= 50,
    riskLevel: "low",
  }));
  const report = evaluateDecisionQuality(reviews);
  assert.equal(report.reviewed, 100);
  assert.equal(report.predictedNoReply, 50);
  assert.equal(report.correctNoReply, 48);
  assert.equal(report.noReplyAccuracy, 0.96);
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
  assert.equal(group.falseReplyRecommendations, 1);
  assert.equal(group.highRiskFalseReplyRecommendations, 1);
  assert.equal(
    report.some(
      (row) => row.dimension === "判断来源" && row.label === "model",
    ),
    true,
  );
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
      task("3", { shouldReply: false, riskLevel: "low", decisionSource: "model" }),
    ],
    [{ taskId: "1" }],
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
  }]);
  assert.equal(report.gates.enoughSamples, false);
  assert.equal(report.gates.noReplyAccuracy, false);
  assert.equal(report.highRiskFalseReplyRecommendations, 1);
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

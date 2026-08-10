import { createHash } from "node:crypto";

export function planResultTaskId(planId) {
  return `plan_result_${createHash("sha256").update(String(planId)).digest("hex").slice(0, 24)}`;
}

export function buildPlanResultDraft({ plan, steps, now = new Date() }) {
  if (!plan?.plan?.sourceTaskId) return null;
  if (!["completed", "failed", "cancelled"].includes(plan.status)) return null;
  const completed = steps.filter((step) => step.status === "completed");
  const failed = steps.find((step) => step.status === "failed");
  const title = plan.status === "completed"
    ? "你交代的任务已经完成。"
    : plan.status === "cancelled"
      ? "你交代的任务已经取消，后续步骤没有继续执行。"
      : `你交代的任务在“${failed?.capability ?? "未知步骤"}”处停止，需要人工处理。`;
  const completedText = completed.length > 0
    ? `已完成：${completed.map((step) => step.capability).join("、")}。`
    : "尚无可确认的已完成步骤。";
  const reply = `${title}${completedText}详细执行证据已保存在 AI 员工管理台，确认后可以发送本条结果。`;
  return {
    id: planResultTaskId(plan.id),
    sourceTaskId: plan.plan.sourceTaskId,
    payload: {
      content: "工作计划执行结果",
      messages: [],
      latestCreateTime: now.toISOString(),
      sourceWorkPlanId: plan.id,
    },
    result: {
      shouldReply: true,
      reply,
      confidence: 1,
      riskLevel: ["L3", "L4"].includes(plan.max_level) ? "high" : "medium",
      reason: "工作计划已经进入终态，结果需要回传原会话并由负责人审核。",
      needsInformation: false,
      relatedToWaitingTask: false,
      decisionSource: "work-plan-result",
      decisionKind: `work_plan_${plan.status}`,
    },
  };
}

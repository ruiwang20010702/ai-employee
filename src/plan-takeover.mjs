import { capabilityCatalog } from "./capability-policy.mjs";

const activePlanStatuses = new Set(["executing", "verifying"]);
const terminalPlanStatuses = new Set(["completed", "failed", "cancelled"]);
const activeStepStatuses = new Set(["executing", "verifying"]);

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stepSnapshot(step, record) {
  const definition = capabilityCatalog[step.capability] ?? {};
  return {
    id: step.id,
    capability: step.capability,
    description: step.description,
    status: record?.status ?? "pending",
    sideEffect: Boolean(definition.sideEffect),
    interruptible: Boolean(definition.interruptible),
    verification: record?.evidence?.verification ?? null,
    evidenceKind: record?.evidence?.kind ?? null,
    terminationSignal: record?.evidence?.terminationSignal ?? null,
    error: record?.error ?? null,
    startedAt: record?.started_at ?? null,
    completedAt: record?.completed_at ?? null,
  };
}

export function buildPlanTakeover(plan, stepRecords = [], { now = new Date() } = {}) {
  if (!plan?.id || !Array.isArray(plan.plan?.steps)) {
    throw new Error("A persisted work plan is required");
  }
  const recordByStep = new Map(
    stepRecords.map((record) => [record.step_id, record]),
  );
  const steps = plan.plan.steps.map((step) =>
    stepSnapshot(step, recordByStep.get(step.id)));
  const activeStep = steps.find((step) => activeStepStatuses.has(step.status));
  const pendingStep = steps.find((step) => step.status === "pending");
  const lastSettledStep = [...steps]
    .reverse()
    .find((step) => step.status !== "pending");
  const currentStep = activeStep ?? pendingStep ?? lastSettledStep ?? null;
  const cancellationRequested = Boolean(plan.cancel_requested_at);
  const leaseExpiresAt = validDate(plan.lease_expires_at);
  const leaseExpired = activePlanStatuses.has(plan.status) &&
    leaseExpiresAt != null && leaseExpiresAt <= now;
  const interruptionConfirmed = steps.some(
    (step) =>
      step.status === "cancelled" &&
      step.error === "operator_interrupted" &&
      step.verification === "operator_interrupt_confirmed",
  );

  let state;
  let stateLabel;
  let handoffAction;
  if (interruptionConfirmed) {
    state = "interrupt_confirmed";
    stateLabel = "已确认中断";
    handoffAction = "核对已保存证据后，可由负责人从当前步骤人工继续；系统不会自动重放。";
  } else if (leaseExpired) {
    state = "lease_expired";
    stateLabel = "执行租约已过期";
    handoffAction = "先核对外部系统实际状态和最后证据，再决定回滚或重新建计划，禁止直接重试。";
  } else if (cancellationRequested && activeStep?.interruptible) {
    state = "interrupt_requested";
    stateLabel = "正在请求中断";
    handoffAction = "等待执行器记录中断确认；确认前不要在同一目标重复执行。";
  } else if (cancellationRequested && activeStep) {
    state = "safe_finishing";
    stateLabel = "正在安全收尾";
    handoffAction = "当前外部动作不能强制中断；等待回读或回滚证据落库，后续步骤不会继续。";
  } else if (activeStep?.sideEffect) {
    state = "side_effect_running";
    stateLabel = "外部动作执行中";
    handoffAction = activeStep.interruptible
      ? "如需接管，请先请求停止并等待中断确认。"
      : "如需接管，请请求停止；系统会完成当前动作的回读或回滚后停步。";
  } else if (activeStep) {
    state = "interruptible_running";
    stateLabel = "可安全请求中断";
    handoffAction = "可请求停止；收到中断确认后再人工继续。";
  } else if (plan.status === "failed") {
    state = "needs_reconciliation";
    stateLabel = "需要人工核对";
    handoffAction = "根据最后步骤证据核对实际结果；有副作用时先回读目标状态，再决定修订或重建计划。";
  } else if (plan.status === "cancelled") {
    state = "cancelled";
    stateLabel = "已取消";
    handoffAction = "核对已完成步骤；如需继续，创建新计划并重新审批。";
  } else if (plan.status === "completed") {
    state = "completed";
    stateLabel = "已完成";
    handoffAction = "核对验证证据和结果回传，无需接管。";
  } else {
    state = "not_running";
    stateLabel = "尚未执行";
    handoffAction = "可在执行前修改、拒绝或取消；未产生外部副作用。";
  }

  return {
    state,
    stateLabel,
    handoffAction,
    currentStep,
    cancellationRequested,
    cancellationRequestedAt: plan.cancel_requested_at ?? null,
    leaseExpiresAt: plan.lease_expires_at ?? null,
    leaseExpired,
    canRequestCancellation:
      !cancellationRequested &&
      ["ready", "awaiting_approval", "approved", "executing", "verifying"]
        .includes(plan.status),
    terminal: terminalPlanStatuses.has(plan.status),
    completedSteps: steps.filter((step) => step.status === "completed").length,
    totalSteps: steps.length,
  };
}

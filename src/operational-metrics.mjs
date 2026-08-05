import { normalizeMessageCoverage } from "./message-reconciliation.mjs";

const taskOutcomes = new Set(["completed", "no_reply", "dead", "send_unknown"]);
const successfulTaskOutcomes = new Set(["completed", "no_reply"]);

function timestamp(value) {
  if (value == null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function duration(start, end) {
  const left = timestamp(start);
  const right = timestamp(end);
  if (left == null || right == null || right < left) return null;
  return right - left;
}

function percentile(values, fraction) {
  const valid = values.filter(Number.isFinite).filter((value) => value >= 0);
  if (valid.length === 0) return null;
  valid.sort((left, right) => left - right);
  return valid[Math.max(0, Math.ceil(valid.length * fraction) - 1)];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

export function buildOperationalMetrics(
  {
    messages = [],
    tasks = [],
    sideEffects = [],
    messageCoverage = null,
    availability = null,
    memoryConflicts = null,
    truncated = {},
  },
  { since, now = new Date() },
) {
  const start = timestamp(since);
  const end = timestamp(now);
  if (start == null || end == null || start >= end) {
    throw new Error("A valid operational metrics window is required");
  }
  const detectionLatencies = messages
    .map((message) => duration(message.occurredAt, message.ingestedAt))
    .filter((value) => value != null);
  const lowRiskOutcomes = tasks.filter(
    (task) => task.result?.riskLevel === "low" && taskOutcomes.has(task.status),
  );
  const lowRiskSuccesses = lowRiskOutcomes.filter((task) =>
    successfulTaskOutcomes.has(task.status));
  const taskDurations = lowRiskOutcomes
    .map((task) => duration(task.created_at, task.draft_ready_at))
    .filter((value) => value != null);
  const lifecycleDurations = lowRiskOutcomes
    .map((task) => duration(task.created_at, task.updated_at))
    .filter((value) => value != null);
  const approvalWaits = tasks
    .map((task) => duration(task.draft_ready_at, task.decision_at))
    .filter((value) => value != null);
  const completedSideEffects = sideEffects.filter(
    (effect) => effect.status === "completed",
  );
  const sideEffectCounts = new Map();
  for (const effect of sideEffects) {
    const key = `${effect.taskId}\n${effect.capability}`;
    sideEffectCounts.set(key, (sideEffectCounts.get(key) ?? 0) + 1);
  }
  const duplicateSideEffects = [...sideEffectCounts.values()]
    .filter((count) => count > 1)
    .reduce((total, count) => total + count - 1, 0);
  const detectionLatencyP95Ms = percentile(detectionLatencies, 0.95);
  const lowRiskTaskDurationP95Ms = percentile(taskDurations, 0.95);
  const lowRiskTaskLifecycleP95Ms = percentile(lifecycleDurations, 0.95);
  const approvalWaitP95Ms = percentile(approvalWaits, 0.95);
  const sideEffectAuditCoverage = ratio(
    completedSideEffects.filter((effect) => effect.receiptPresent).length,
    completedSideEffects.length,
  );
  return {
    availability,
    memoryConflicts,
    window: {
      since: new Date(start).toISOString(),
      until: new Date(end).toISOString(),
      dataComplete: !Object.values(truncated).some(Boolean),
      truncated: {
        messages: Boolean(truncated.messages),
        tasks: Boolean(truncated.tasks),
        sideEffects: Boolean(truncated.sideEffects),
      },
    },
    messageDetection: {
      samples: detectionLatencies.length,
      p95Ms: detectionLatencyP95Ms,
      targetMs: 5_000,
      targetMet: detectionLatencyP95Ms == null ? null : detectionLatencyP95Ms < 5_000,
    },
    messageCoverage: normalizeMessageCoverage(messageCoverage),
    lowRiskTasks: {
      samples: lowRiskOutcomes.length,
      successes: lowRiskSuccesses.length,
      successRate: ratio(lowRiskSuccesses.length, lowRiskOutcomes.length),
      successRateTarget: 0.95,
      successRateTargetMet: lowRiskOutcomes.length === 0
        ? null
        : lowRiskSuccesses.length / lowRiskOutcomes.length >= 0.95,
      durationSamples: taskDurations.length,
      durationP95Ms: lowRiskTaskDurationP95Ms,
      durationTargetMs: 120_000,
      durationTargetMet: lowRiskTaskDurationP95Ms == null
        ? null
        : lowRiskTaskDurationP95Ms < 120_000,
      lifecycleSamples: lifecycleDurations.length,
      lifecycleP95Ms: lowRiskTaskLifecycleP95Ms,
    },
    approvalWait: {
      samples: approvalWaits.length,
      p95Ms: approvalWaitP95Ms,
    },
    reliability: {
      duplicateSideEffects,
      unknownSideEffects: sideEffects.filter((effect) => effect.status === "unknown").length,
      completedSideEffects: completedSideEffects.length,
      sideEffectAuditCoverage,
      codexTimeouts: tasks.filter((task) => /timeout/iu.test(task.last_error ?? "")).length,
      deadTasks: tasks.filter((task) => task.status === "dead").length,
    },
  };
}

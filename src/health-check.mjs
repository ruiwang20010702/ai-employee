import { access, constants } from "node:fs/promises";
import {
  messageCoverageCheckpointKey,
  normalizeMessageCoverage,
} from "./message-reconciliation.mjs";

async function executable(path) {
  return access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false);
}

function metricLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

export async function evaluateHealth({
  store,
  config,
  now = new Date(),
  includeOperationalMetrics = false,
}) {
  const [state, operationalMetrics] = await Promise.all([
    store.health(),
    includeOperationalMetrics && store.operationalMetrics
      ? store.operationalMetrics({
          since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          now,
          availabilityIntervalMs: config.availabilitySampleIntervalMs,
          availabilityWindowMs: config.availabilityWindowMs,
        })
      : null,
  ]);
  const checkpointRows = new Map(
    (state.checkpoints ?? []).map((checkpoint) => [checkpoint.key, checkpoint]),
  );
  const heartbeats = Object.fromEntries(
    config.requiredComponents.map((component) => {
      const value = state.heartbeats?.[component] ?? null;
      const ageMs = value ? now.getTime() - new Date(value).getTime() : null;
      return [
        component,
        {
          lastSeenAt: value,
          ageMs,
          healthy:
            ageMs != null &&
            Number.isFinite(ageMs) &&
            ageMs >= 0 &&
            ageMs <= config.heartbeatStaleMs,
        },
      ];
    }),
  );
  const operationalChecks = Object.fromEntries(
    (config.requiredOperationalChecks ?? []).map((key) => {
      const checkpoint = checkpointRows.get(key);
      const failureKey = key.replace(/last-success$/u, "last-failure");
      const failure = checkpointRows.get(failureKey);
      const lastSeenAt = checkpoint?.updated_at ?? null;
      const ageMs = lastSeenAt
        ? now.getTime() - new Date(lastSeenAt).getTime()
        : null;
      const failureIsNewer =
        Boolean(failure?.updated_at) &&
        (!lastSeenAt ||
          new Date(failure.updated_at).getTime() > new Date(lastSeenAt).getTime());
      return [
        key,
        {
          lastSeenAt,
          ageMs,
          healthy:
            !failureIsNewer &&
            ageMs != null &&
            Number.isFinite(ageMs) &&
            ageMs >= 0 &&
            ageMs <= config.externalCheckStaleMs,
        },
      ];
    }),
  );
  const coverageCheckpoint = checkpointRows.get(messageCoverageCheckpointKey);
  const coverageFailure = checkpointRows.get(
    "reconciliation:message-coverage:last-failure",
  );
  const messageCoverage = normalizeMessageCoverage(coverageCheckpoint?.value);
  const coverageAgeMs = messageCoverage?.checkedAt
    ? now.getTime() - new Date(messageCoverage.checkedAt).getTime()
    : null;
  const coverageFailureIsNewer =
    Boolean(coverageFailure?.updated_at) &&
    (!coverageCheckpoint?.updated_at ||
      new Date(coverageFailure.updated_at).getTime() >
        new Date(coverageCheckpoint.updated_at).getTime());
  const messageCoverageCheck = {
    required: Boolean(config.requireMessageReconciliation),
    available: Boolean(messageCoverage),
    ageMs: coverageAgeMs,
    dataComplete: messageCoverage?.dataComplete ?? false,
    sourceMessages: messageCoverage?.sourceMessages ?? 0,
    remainingMissing: messageCoverage?.remainingMissing ?? null,
    healthy:
      Boolean(messageCoverage) &&
      !coverageFailureIsNewer &&
      Number.isFinite(coverageAgeMs) &&
      coverageAgeMs >= 0 &&
      coverageAgeMs <= config.reconciliationStaleMs &&
      messageCoverage.dataComplete &&
      messageCoverage.remainingMissing === 0,
  };
  const checks = {
    database: Boolean(state.database),
    dwsExecutable: await executable(config.dwsPath),
    codexExecutable: await executable(config.codexPath),
    paused: state.paused,
    deadTasks: state.tasks.dead ?? 0,
    unknownSends: state.tasks.send_unknown ?? 0,
    failedWorkPlans: state.workPlans?.failed ?? 0,
    executingWorkPlans:
      (state.workPlans?.executing ?? 0) + (state.workPlans?.verifying ?? 0),
    expiredExecutionLeases: state.expiredExecutionLeases ?? 0,
    pendingMessages: state.pendingMessages,
    checkpoints: state.checkpoints.length,
    heartbeats,
    operationalChecks,
    messageCoverage: messageCoverageCheck,
    operationalMetrics,
  };
  const ready =
    checks.database &&
    checks.dwsExecutable &&
    checks.codexExecutable &&
    !checks.paused &&
    checks.deadTasks === 0 &&
    checks.unknownSends === 0 &&
    checks.expiredExecutionLeases === 0 &&
    Object.values(heartbeats).every((heartbeat) => heartbeat.healthy) &&
    Object.values(operationalChecks).every((check) => check.healthy) &&
    (!messageCoverageCheck.required || messageCoverageCheck.healthy);
  return { ready, checks, state };
}

export function prometheusMetrics(health) {
  const lines = [
    "# HELP ai_employee_ready Whether all production dependencies are ready.",
    "# TYPE ai_employee_ready gauge",
    `ai_employee_ready ${health.ready ? 1 : 0}`,
    "# HELP ai_employee_dead_tasks Tasks that exhausted all retries.",
    "# TYPE ai_employee_dead_tasks gauge",
    `ai_employee_dead_tasks ${health.checks.deadTasks}`,
    "# HELP ai_employee_unknown_sends Sends requiring manual reconciliation.",
    "# TYPE ai_employee_unknown_sends gauge",
    `ai_employee_unknown_sends ${health.checks.unknownSends}`,
    "# HELP ai_employee_failed_work_plans Work plans requiring review.",
    "# TYPE ai_employee_failed_work_plans gauge",
    `ai_employee_failed_work_plans ${health.checks.failedWorkPlans}`,
    "# HELP ai_employee_executing_work_plans Work plans currently executing or verifying.",
    "# TYPE ai_employee_executing_work_plans gauge",
    `ai_employee_executing_work_plans ${health.checks.executingWorkPlans}`,
    "# HELP ai_employee_expired_execution_leases Executions interrupted without recovery.",
    "# TYPE ai_employee_expired_execution_leases gauge",
    `ai_employee_expired_execution_leases ${health.checks.expiredExecutionLeases}`,
    "# HELP ai_employee_pending_messages Messages waiting for bundling.",
    "# TYPE ai_employee_pending_messages gauge",
    `ai_employee_pending_messages ${health.checks.pendingMessages}`,
  ];
  const operations = health.checks.operationalMetrics;
  if (operations) {
    lines.push(
      "# HELP ai_employee_metrics_window_data_complete Whether the bounded SLO window contains all rows.",
      "# TYPE ai_employee_metrics_window_data_complete gauge",
      `ai_employee_metrics_window_data_complete ${operations.window.dataComplete ? 1 : 0}`,
      "# HELP ai_employee_message_detection_samples Messages included in detection latency metrics.",
      "# TYPE ai_employee_message_detection_samples gauge",
      `ai_employee_message_detection_samples ${operations.messageDetection.samples}`,
      "# HELP ai_employee_source_reconciliation_available Whether a valid source reconciliation report is available.",
      "# TYPE ai_employee_source_reconciliation_available gauge",
      `ai_employee_source_reconciliation_available ${operations.messageCoverage ? 1 : 0}`,
      "# HELP ai_employee_low_risk_task_samples Low-risk terminal tasks in the SLO window.",
      "# TYPE ai_employee_low_risk_task_samples gauge",
      `ai_employee_low_risk_task_samples ${operations.lowRiskTasks.samples}`,
      "# HELP ai_employee_low_risk_task_duration_samples Low-risk tasks with draft-ready timing in the SLO window.",
      "# TYPE ai_employee_low_risk_task_duration_samples gauge",
      `ai_employee_low_risk_task_duration_samples ${operations.lowRiskTasks.durationSamples}`,
      "# HELP ai_employee_low_risk_task_lifecycle_samples Low-risk terminal tasks with lifecycle timing in the SLO window.",
      "# TYPE ai_employee_low_risk_task_lifecycle_samples gauge",
      `ai_employee_low_risk_task_lifecycle_samples ${operations.lowRiskTasks.lifecycleSamples}`,
      "# HELP ai_employee_duplicate_side_effects Duplicate side-effect records by task and capability.",
      "# TYPE ai_employee_duplicate_side_effects gauge",
      `ai_employee_duplicate_side_effects ${operations.reliability.duplicateSideEffects}`,
      "# HELP ai_employee_unknown_side_effects Side effects requiring manual reconciliation.",
      "# TYPE ai_employee_unknown_side_effects gauge",
      `ai_employee_unknown_side_effects ${operations.reliability.unknownSideEffects}`,
      "# HELP ai_employee_codex_timeouts Tasks whose latest failure is a timeout.",
      "# TYPE ai_employee_codex_timeouts gauge",
      `ai_employee_codex_timeouts ${operations.reliability.codexTimeouts}`,
    );
    if (operations.availability) {
      lines.push(
        "# HELP ai_employee_availability_tracking_coverage_ratio Fraction of the configured monthly window observed.",
        "# TYPE ai_employee_availability_tracking_coverage_ratio gauge",
        `ai_employee_availability_tracking_coverage_ratio ${operations.availability.trackingCoverage.toFixed(6)}`,
        "# HELP ai_employee_availability_expected_samples Completed availability buckets since tracking began.",
        "# TYPE ai_employee_availability_expected_samples gauge",
        `ai_employee_availability_expected_samples ${operations.availability.expectedSamples}`,
        "# HELP ai_employee_availability_recorded_samples Availability buckets containing a probe.",
        "# TYPE ai_employee_availability_recorded_samples gauge",
        `ai_employee_availability_recorded_samples ${operations.availability.recordedSamples}`,
        "# HELP ai_employee_availability_missing_samples Completed buckets without a probe, counted unavailable.",
        "# TYPE ai_employee_availability_missing_samples gauge",
        `ai_employee_availability_missing_samples ${operations.availability.missingSamples}`,
        "# HELP ai_employee_availability_window_complete Whether a full monthly window has been observed.",
        "# TYPE ai_employee_availability_window_complete gauge",
        `ai_employee_availability_window_complete ${operations.availability.windowComplete ? 1 : 0}`,
      );
      if (operations.availability.availability != null) {
        lines.push(
          "# HELP ai_employee_monthly_availability_ratio Ready buckets divided by all expected buckets; missing probes are unavailable.",
          "# TYPE ai_employee_monthly_availability_ratio gauge",
          `ai_employee_monthly_availability_ratio ${operations.availability.availability.toFixed(6)}`,
        );
      }
    }
    if (operations.memoryConflicts) {
      lines.push(
        "# HELP ai_employee_memory_conflict_candidates Proposed memories conflicting with an active fact.",
        "# TYPE ai_employee_memory_conflict_candidates gauge",
        `ai_employee_memory_conflict_candidates ${operations.memoryConflicts.conflictCandidates}`,
        "# HELP ai_employee_memory_duplicate_candidates Proposed memories duplicating an active fact.",
        "# TYPE ai_employee_memory_duplicate_candidates gauge",
        `ai_employee_memory_duplicate_candidates ${operations.memoryConflicts.duplicateCandidates}`,
        "# HELP ai_employee_memory_active_conflict_groups Active subjects containing contradictory confirmed facts.",
        "# TYPE ai_employee_memory_active_conflict_groups gauge",
        `ai_employee_memory_active_conflict_groups ${operations.memoryConflicts.activeConflictGroups}`,
      );
      if (operations.memoryConflicts.conflictRate != null) {
        lines.push(
          "# HELP ai_employee_memory_candidate_conflict_ratio Proposed memories requiring conflict replacement.",
          "# TYPE ai_employee_memory_candidate_conflict_ratio gauge",
          `ai_employee_memory_candidate_conflict_ratio ${operations.memoryConflicts.conflictRate.toFixed(6)}`,
        );
      }
    }
    if (operations.messageCoverage) {
      lines.push(
        "# HELP ai_employee_source_reconciliation_data_complete Whether the latest source reconciliation covered its full window.",
        "# TYPE ai_employee_source_reconciliation_data_complete gauge",
        `ai_employee_source_reconciliation_data_complete ${operations.messageCoverage.dataComplete ? 1 : 0}`,
        "# HELP ai_employee_source_reconciliation_messages Source messages in the latest reconciliation window.",
        "# TYPE ai_employee_source_reconciliation_messages gauge",
        `ai_employee_source_reconciliation_messages ${operations.messageCoverage.sourceMessages}`,
        "# HELP ai_employee_source_reconciliation_missed_before_repair Messages absent before reconciliation repair.",
        "# TYPE ai_employee_source_reconciliation_missed_before_repair gauge",
        `ai_employee_source_reconciliation_missed_before_repair ${operations.messageCoverage.missedBeforeRepair}`,
        "# HELP ai_employee_source_reconciliation_repaired Messages restored by reconciliation.",
        "# TYPE ai_employee_source_reconciliation_repaired gauge",
        `ai_employee_source_reconciliation_repaired ${operations.messageCoverage.repairedMessages}`,
        "# HELP ai_employee_source_reconciliation_remaining_missing Messages still absent after repair.",
        "# TYPE ai_employee_source_reconciliation_remaining_missing gauge",
        `ai_employee_source_reconciliation_remaining_missing ${operations.messageCoverage.remainingMissing}`,
      );
      if (operations.messageCoverage.observedMissRate != null) {
        lines.push(
          "# HELP ai_employee_source_reconciliation_observed_miss_ratio Messages missed by normal ingestion before reconciliation.",
          "# TYPE ai_employee_source_reconciliation_observed_miss_ratio gauge",
          `ai_employee_source_reconciliation_observed_miss_ratio ${operations.messageCoverage.observedMissRate.toFixed(6)}`,
        );
      }
      if (operations.messageCoverage.finalMissRate != null) {
        lines.push(
          "# HELP ai_employee_source_reconciliation_final_miss_ratio Messages still missing after reconciliation repair.",
          "# TYPE ai_employee_source_reconciliation_final_miss_ratio gauge",
          `ai_employee_source_reconciliation_final_miss_ratio ${operations.messageCoverage.finalMissRate.toFixed(6)}`,
        );
      }
    }
    if (operations.messageDetection.p95Ms != null) {
      lines.push(
        "# HELP ai_employee_message_detection_p95_seconds P95 message occurrence-to-ingestion delay.",
        "# TYPE ai_employee_message_detection_p95_seconds gauge",
        `ai_employee_message_detection_p95_seconds ${(operations.messageDetection.p95Ms / 1000).toFixed(3)}`,
      );
    }
    if (operations.lowRiskTasks.successRate != null) {
      lines.push(
        "# HELP ai_employee_low_risk_task_success_ratio Successful low-risk terminal task ratio.",
        "# TYPE ai_employee_low_risk_task_success_ratio gauge",
        `ai_employee_low_risk_task_success_ratio ${operations.lowRiskTasks.successRate.toFixed(6)}`,
      );
    }
    if (operations.lowRiskTasks.durationP95Ms != null) {
      lines.push(
        "# HELP ai_employee_low_risk_task_duration_p95_seconds P95 low-risk task creation-to-draft-ready duration excluding human wait.",
        "# TYPE ai_employee_low_risk_task_duration_p95_seconds gauge",
        `ai_employee_low_risk_task_duration_p95_seconds ${(operations.lowRiskTasks.durationP95Ms / 1000).toFixed(3)}`,
      );
    }
    if (operations.lowRiskTasks.lifecycleP95Ms != null) {
      lines.push(
        "# HELP ai_employee_low_risk_task_lifecycle_p95_seconds P95 low-risk task creation-to-terminal duration including human wait.",
        "# TYPE ai_employee_low_risk_task_lifecycle_p95_seconds gauge",
        `ai_employee_low_risk_task_lifecycle_p95_seconds ${(operations.lowRiskTasks.lifecycleP95Ms / 1000).toFixed(3)}`,
      );
    }
    if (operations.approvalWait.p95Ms != null) {
      lines.push(
        "# HELP ai_employee_approval_wait_p95_seconds P95 draft-ready-to-decision delay.",
        "# TYPE ai_employee_approval_wait_p95_seconds gauge",
        `ai_employee_approval_wait_p95_seconds ${(operations.approvalWait.p95Ms / 1000).toFixed(3)}`,
      );
    }
    if (operations.reliability.sideEffectAuditCoverage != null) {
      lines.push(
        "# HELP ai_employee_side_effect_audit_coverage_ratio Completed side effects with a stored receipt.",
        "# TYPE ai_employee_side_effect_audit_coverage_ratio gauge",
        `ai_employee_side_effect_audit_coverage_ratio ${operations.reliability.sideEffectAuditCoverage.toFixed(6)}`,
      );
    }
  }
  for (const [component, heartbeat] of Object.entries(
    health.checks.heartbeats,
  )) {
    lines.push(
      `ai_employee_component_heartbeat_healthy{component="${metricLabel(component)}"} ${
        heartbeat.healthy ? 1 : 0
      }`,
    );
    if (heartbeat.ageMs != null) {
      lines.push(
        `ai_employee_component_heartbeat_age_seconds{component="${metricLabel(component)}"} ${(
          heartbeat.ageMs / 1000
        ).toFixed(3)}`,
      );
    }
  }
  for (const [check, status] of Object.entries(
    health.checks.operationalChecks,
  )) {
    lines.push(
      `ai_employee_operational_check_healthy{check="${metricLabel(check)}"} ${
        status.healthy ? 1 : 0
      }`,
    );
    if (status.ageMs != null) {
      lines.push(
        `ai_employee_operational_check_age_seconds{check="${metricLabel(check)}"} ${(
          status.ageMs / 1000
        ).toFixed(3)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

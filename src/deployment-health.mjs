function allHealthy(values, { allowEmpty = true } = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return false;
  const entries = Object.values(values);
  return (allowEmpty || entries.length > 0) &&
    entries.every((value) => value?.healthy === true);
}

export function deploymentVerificationTimeout(value = 90_000) {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error("Service verification timeout must be between 1000 and 300000 ms");
  }
  return timeout;
}

export function evaluateDeploymentHealth({
  liveStatus,
  liveBody,
  readyStatus,
  readyBody,
  adminStatus,
  releaseServices,
}) {
  const checks = readyBody?.checks;
  const failures = [];
  if (liveStatus !== 200 || liveBody?.status !== "alive") {
    failures.push("health_process_unavailable");
  }
  if (![200, 503].includes(readyStatus) || !checks || typeof checks !== "object") {
    failures.push("health_payload_invalid");
  } else {
    if (
      (readyStatus === 200 && readyBody?.status !== "ready") ||
      (readyStatus === 503 && readyBody?.status !== "degraded")
    ) {
      failures.push("health_status_mismatch");
    }
    if (checks.database !== true) failures.push("database_unavailable");
    if (checks.dwsExecutable !== true) failures.push("dws_unavailable");
    if (checks.codexExecutable !== true) failures.push("codex_unavailable");
    if (!allHealthy(checks.heartbeats, { allowEmpty: false })) {
      failures.push("heartbeat_unhealthy");
    }
    if (!allHealthy(checks.operationalChecks)) {
      failures.push("operational_check_unhealthy");
    }
    if (checks.messageCoverage?.required && checks.messageCoverage?.healthy !== true) {
      failures.push("message_coverage_unhealthy");
    }
    if (Number(checks.unknownSends ?? 0) !== 0) {
      failures.push("unknown_sends_present");
    }
    if (Number(checks.expiredExecutionLeases ?? 0) !== 0) {
      failures.push("expired_execution_leases_present");
    }
  }
  if (adminStatus !== 200) failures.push("admin_unavailable");
  if (releaseServices?.verified !== true) {
    failures.push("release_services_unverified");
  }

  const blockers = [];
  if (checks?.paused) blockers.push("paused");
  if (Number(checks?.deadTasks ?? 0) > 0) blockers.push("dead_tasks");
  if (Number(checks?.failedWorkPlans ?? 0) > 0) blockers.push("failed_work_plans");
  if (Number(checks?.executingWorkPlans ?? 0) > 0) blockers.push("active_work_plans");

  return {
    verified: failures.length === 0,
    serviceAvailable: failures.length === 0,
    businessReady:
      failures.length === 0 &&
      readyStatus === 200 &&
      readyBody?.status === "ready" &&
      blockers.length === 0,
    failures,
    blockers,
    releaseServices: {
      verified: releaseServices?.verified === true,
      failedLabels: releaseServices?.failedLabels ?? [],
    },
    counts: {
      deadTasks: Number(checks?.deadTasks ?? 0),
      unknownSends: Number(checks?.unknownSends ?? 0),
      expiredExecutionLeases: Number(checks?.expiredExecutionLeases ?? 0),
    },
  };
}

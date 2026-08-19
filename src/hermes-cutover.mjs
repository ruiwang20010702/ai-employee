const terminalTaskStatuses = new Set([
  "no_reply",
  "rejected",
  "completed",
  "cancelled_manual",
  "cancelled_operator",
  "expired",
  "continued",
]);

const terminalPlanStatuses = new Set([
  "completed",
  "cancelled",
  "rejected",
  "superseded",
]);

const acceptanceScenarios = Object.freeze([
  "allowlistedMessage",
  "projectRoute",
  "personalMemory",
  "naturalReply",
  "followup",
  "codeWork",
  "humanTakeover",
  "restartRecovery",
  "sendDisabled",
  "noDuplicate",
]);

const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;

function positiveStatuses(rows, terminal) {
  return Object.entries(rows ?? {})
    .filter(([, count]) => Number(count) > 0)
    .filter(([status]) => !terminal.has(status))
    .map(([status, count]) => ({ status, count: Number(count) }));
}

export function assertLegacyCutoverReady(state) {
  if (!state?.database) throw new Error("Legacy database is unavailable");
  if (state.paused) throw new Error("Legacy runtime is globally paused");
  if (Number(state.pendingMessages ?? 0) !== 0) {
    throw new Error("Legacy pending messages must be zero before cutover");
  }
  if (Number(state.expiredExecutionLeases ?? 0) !== 0) {
    throw new Error("Legacy expired execution leases must be zero before cutover");
  }
  const tasks = positiveStatuses(state.tasks, terminalTaskStatuses);
  if (tasks.length > 0) {
    throw new Error(`Legacy active tasks block cutover: ${tasks.map(
      ({ status, count }) => `${status}=${count}`,
    ).join(",")}`);
  }
  const workPlans = positiveStatuses(state.workPlans, terminalPlanStatuses);
  if (workPlans.length > 0) {
    throw new Error(`Legacy active work plans block cutover: ${workPlans.map(
      ({ status, count }) => `${status}=${count}`,
    ).join(",")}`);
  }
  return { ready: true, activeTasks: 0, activeWorkPlans: 0 };
}

export function assertHermesShadowReady(status) {
  if (
    status?.mode !== "shadow" ||
    status.running !== true ||
    status.sendEnabled !== false ||
    status.checkpointHealthy !== true
  ) throw new Error("Hermes shadow is not ready for cutover");
  return { ready: true };
}

export function assertHermesActiveReady(status) {
  if (
    status?.mode !== "active" ||
    status.running !== true ||
    status.sendEnabled !== true ||
    status.checkpointHealthy !== true
  ) throw new Error("Hermes active runtime did not pass readback");
  return { ready: true };
}

export function assertHermesShadowAcceptance(receipt, {
  releaseSha,
  now = new Date(),
  maximumAgeMs = 7 * 24 * 60 * 60 * 1_000,
} = {}) {
  if (!fullSha.test(String(releaseSha ?? ""))) {
    throw new Error("Hermes cutover requires an exact release SHA");
  }
  if (
    !receipt ||
    Array.isArray(receipt) ||
    receipt.schema !== "foursday-hermes-shadow-acceptance/v1" ||
    receipt.releaseSha !== releaseSha ||
    !digest.test(String(receipt.evidenceDigest ?? ""))
  ) throw new Error("Hermes shadow acceptance receipt is invalid");
  const createdAt = new Date(receipt.createdAt).getTime();
  const age = now.getTime() - createdAt;
  if (!Number.isFinite(age) || age < 0 || age > maximumAgeMs) {
    throw new Error("Hermes shadow acceptance receipt is stale");
  }
  const missing = acceptanceScenarios.filter(
    (scenario) => receipt.scenarios?.[scenario] !== true,
  );
  if (missing.length > 0) {
    throw new Error(`Hermes shadow acceptance is incomplete: ${missing.join(",")}`);
  }
  return {
    valid: true,
    releaseSha,
    scenarioCount: acceptanceScenarios.length,
    evidenceDigest: receipt.evidenceDigest,
  };
}

export function hermesCutoverConfirmation({ releaseSha, evidenceDigest }) {
  if (!fullSha.test(String(releaseSha ?? "")) || !digest.test(String(evidenceDigest ?? ""))) {
    throw new Error("Hermes cutover confirmation inputs are invalid");
  }
  return `ACTIVATE-HERMES:${releaseSha}:${evidenceDigest.slice(0, 16)}`;
}

export async function executeHermesCutover({
  inspectLegacy,
  inspectShadow,
  stopLegacyWriters,
  startActiveHermes,
  inspectActive,
  stopHermes,
  restoreLegacyWriters,
  verifyLegacyRestored,
  writeReceipt,
}) {
  assertLegacyCutoverReady(await inspectLegacy());
  assertHermesShadowReady(await inspectShadow());
  let legacySnapshot = null;
  let activeStarted = false;
  try {
    legacySnapshot = await stopLegacyWriters();
    const stopped = legacySnapshot?.states ?? {};
    const remaining = ["listener", "worker", "executor", "proactive"]
      .filter((component) => stopped[component] !== "stopped");
    if (remaining.length > 0) {
      throw new Error(`Legacy writers did not stop: ${remaining.join(",")}`);
    }
    await startActiveHermes({ legacySnapshot });
    activeStarted = true;
    const active = await inspectActive();
    assertHermesActiveReady(active);
    const receipt = await writeReceipt({
      activatedAt: new Date().toISOString(),
      legacySnapshot,
      active,
    });
    return { activated: true, receipt };
  } catch (error) {
    let rollbackComplete = false;
    try {
      if (activeStarted) {
        await stopHermes();
      }
      if (legacySnapshot) {
        await restoreLegacyWriters({ legacySnapshot });
      }
      rollbackComplete = await verifyLegacyRestored();
    } catch {
      rollbackComplete = false;
    }
    const failure = new Error(
      rollbackComplete
        ? `Hermes cutover failed and legacy writers were restored: ${error.message}`
        : `Hermes cutover failed and legacy writer restoration is incomplete: ${error.message}`,
    );
    failure.code = rollbackComplete
      ? "hermes_cutover_rolled_back"
      : "hermes_cutover_recovery_incomplete";
    failure.rollbackComplete = rollbackComplete;
    throw failure;
  }
}

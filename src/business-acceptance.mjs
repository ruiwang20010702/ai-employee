export function evaluateBusinessAcceptance({ health, quality } = {}) {
  const operational = health?.checks?.operationalMetrics ?? null;
  const completedSideEffects = operational?.reliability?.completedSideEffects;
  const gates = {
    serviceHealth: health?.ready === true,
    decisionQuality: quality?.accepted === true,
    operationalDataComplete: operational?.window?.dataComplete === true,
    availability: operational?.availability?.targetMet === true,
    messageDetection: operational?.messageDetection?.targetMet === true,
    messageCoverage:
      operational?.messageCoverage?.targetMet === true &&
      operational.messageCoverage.remainingMissing === 0,
    lowRiskSuccess: operational?.lowRiskTasks?.successRateTargetMet === true,
    lowRiskDuration: operational?.lowRiskTasks?.durationTargetMet === true,
    duplicateSideEffects:
      operational?.reliability?.duplicateSideEffects === 0,
    unknownSideEffects:
      operational?.reliability?.unknownSideEffects === 0,
    sideEffectAudit:
      completedSideEffects === 0 ||
      (Number.isFinite(completedSideEffects) &&
        operational?.reliability?.sideEffectAuditCoverage === 1),
    memoryConflicts:
      operational?.memoryConflicts?.activeConflictGroups === 0,
  };
  const blockers = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    accepted: blockers.length === 0,
    gates,
    blockers,
  };
}

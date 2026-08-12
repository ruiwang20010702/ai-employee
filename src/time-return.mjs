function minutes(value, name, { allowZero = false } = {}) {
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(number) || number < minimum || number > 10_080) {
    throw new Error(`${name} must be an integer between ${minimum} and 10080`);
  }
  return number;
}

export function buildTimeReturnProposal({
  projectId,
  workPlanId,
  recipeId = null,
  baselineMinutes,
  humanActiveMinutes,
  baselineMethod,
  outcomeEvidence,
}) {
  if (!String(projectId ?? "").trim() || !String(workPlanId ?? "").trim()) {
    throw new Error("Time return requires projectId and workPlanId");
  }
  if (!['measured', 'user_confirmed'].includes(baselineMethod)) {
    throw new Error("Time return baseline must be measured or user_confirmed");
  }
  if (!outcomeEvidence || typeof outcomeEvidence !== "object" || Array.isArray(outcomeEvidence)) {
    throw new Error("Time return requires verified outcome evidence");
  }
  const baseline = minutes(baselineMinutes, "baselineMinutes");
  const human = minutes(humanActiveMinutes, "humanActiveMinutes", { allowZero: true });
  if (human > baseline) throw new Error("humanActiveMinutes cannot exceed baselineMinutes");
  return {
    projectId: String(projectId).trim(),
    workPlanId: String(workPlanId).trim(),
    recipeId: recipeId ? String(recipeId).trim() : null,
    baselineMinutes: baseline,
    humanActiveMinutes: human,
    returnedMinutes: baseline - human,
    baselineMethod,
    outcomeEvidence: structuredClone(outcomeEvidence),
    status: "proposed",
  };
}

export function summarizeTimeReturns(entries, { weeklyTargetMinutes = 480 } = {}) {
  const confirmed = entries.filter((entry) => entry.status === "confirmed");
  const returnedMinutes = confirmed.reduce(
    (sum, entry) => sum + minutes(entry.returnedMinutes, "returnedMinutes", { allowZero: true }),
    0,
  );
  return {
    confirmedEntries: confirmed.length,
    proposedEntries: entries.filter((entry) => entry.status === "proposed").length,
    returnedMinutes,
    returnedHours: Math.round((returnedMinutes / 60) * 10) / 10,
    weeklyTargetMinutes,
    targetProgress: weeklyTargetMinutes === 0
      ? null
      : Math.min(1, returnedMinutes / weeklyTargetMinutes),
    evidenceBoundary: "confirmed_verified_outcomes_only",
  };
}

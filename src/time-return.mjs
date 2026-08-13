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

function weeklyWindow(now, timeZoneOffsetMinutes) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Time return summary now must be a valid date");
  }
  if (timeZoneOffsetMinutes == null) {
    const start = new Date(now);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - daysSinceMonday);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end };
  }
  if (
    !Number.isSafeInteger(timeZoneOffsetMinutes) ||
    timeZoneOffsetMinutes < -14 * 60 ||
    timeZoneOffsetMinutes > 14 * 60
  ) {
    throw new Error("Time return timezone offset must be between -840 and 840 minutes");
  }
  const shifted = new Date(now.getTime() + timeZoneOffsetMinutes * 60_000);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  const localStartMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday,
  );
  const start = new Date(localStartMs - timeZoneOffsetMinutes * 60_000);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { start, end };
}

function confirmedAt(entry) {
  const value = entry.confirmedAt ?? entry.updatedAt;
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error("Confirmed time return requires a valid confirmation timestamp");
  }
  return date;
}

export function summarizeTimeReturns(entries, {
  weeklyTargetMinutes = 480,
  now = new Date(),
  timeZoneOffsetMinutes = null,
} = {}) {
  const window = weeklyWindow(now, timeZoneOffsetMinutes);
  const targetMinutes = minutes(
    weeklyTargetMinutes,
    "weeklyTargetMinutes",
    { allowZero: true },
  );
  const confirmed = entries.filter((entry) => entry.status === "confirmed");
  const weeklyConfirmed = confirmed.filter((entry) => {
    const confirmedTime = confirmedAt(entry);
    return confirmedTime >= window.start && confirmedTime < window.end;
  });
  let confirmedBaselineMinutes = 0;
  let confirmedHumanActiveMinutes = 0;
  let returnedMinutes = 0;
  for (const entry of confirmed) {
    const baseline = minutes(entry.baselineMinutes, "baselineMinutes");
    const human = minutes(entry.humanActiveMinutes, "humanActiveMinutes", { allowZero: true });
    const returned = minutes(entry.returnedMinutes, "returnedMinutes", { allowZero: true });
    if (human > baseline || returned !== baseline - human) {
      throw new Error("Confirmed time return does not match its verified baseline");
    }
    confirmedBaselineMinutes += baseline;
    confirmedHumanActiveMinutes += human;
    returnedMinutes += returned;
  }
  const weeklyBaselineMinutes = weeklyConfirmed.reduce(
    (total, entry) => total + minutes(entry.baselineMinutes, "baselineMinutes"),
    0,
  );
  const weeklyHumanActiveMinutes = weeklyConfirmed.reduce(
    (total, entry) => total + minutes(
      entry.humanActiveMinutes,
      "humanActiveMinutes",
      { allowZero: true },
    ),
    0,
  );
  const weeklyReturnedMinutes = weeklyConfirmed.reduce(
    (total, entry) => total + minutes(entry.returnedMinutes, "returnedMinutes", { allowZero: true }),
    0,
  );
  return {
    confirmedEntries: confirmed.length,
    proposedEntries: entries.filter((entry) => entry.status === "proposed").length,
    confirmedBaselineMinutes,
    confirmedHumanActiveMinutes,
    returnedMinutes,
    returnedHours: Math.round((returnedMinutes / 60) * 10) / 10,
    automationCoverage: confirmedBaselineMinutes === 0
      ? null
      : Math.round((returnedMinutes / confirmedBaselineMinutes) * 10_000) / 10_000,
    weekStart: window.start.toISOString(),
    weekEnd: window.end.toISOString(),
    weeklyConfirmedEntries: weeklyConfirmed.length,
    weeklyBaselineMinutes,
    weeklyHumanActiveMinutes,
    weeklyReturnedMinutes,
    weeklyReturnedHours: Math.round((weeklyReturnedMinutes / 60) * 10) / 10,
    weeklyAutomationCoverage: weeklyBaselineMinutes === 0
      ? null
      : Math.round((weeklyReturnedMinutes / weeklyBaselineMinutes) * 10_000) / 10_000,
    weeklyTargetMinutes: targetMinutes,
    targetProgress: targetMinutes === 0
      ? null
      : Math.min(1, weeklyReturnedMinutes / targetMinutes),
    evidenceBoundary: "confirmed_verified_outcomes_only",
    coverageBoundary: "confirmed_recipe_baseline_only",
    targetBoundary: "confirmed_in_current_local_week_only",
  };
}

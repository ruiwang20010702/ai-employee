import { summarizeTimeReturns } from "./time-return.mjs";

const activePlanStatuses = new Set([
  "ready", "awaiting_approval", "approved", "executing", "verifying",
]);
const availableCapabilityModes = new Set(["automatic", "approval_required"]);
const maximumItems = 10_000;

function boundedArray(value, name) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${name} must be an array with at most ${maximumItems} items`);
  }
  return value;
}

function text(value) {
  return String(value ?? "").trim();
}

function ruleAvailable(rule, now) {
  return Boolean(
    rule &&
    availableCapabilityModes.has(rule.mode) &&
    (!rule.expiresAt || new Date(rule.expiresAt) > now),
  );
}

function evidenceFor(timeReturns, projectId, recipeId) {
  const entries = timeReturns.filter((entry) =>
    entry.status === "confirmed" &&
    entry.projectId === projectId &&
    entry.recipeId === recipeId
  );
  if (entries.length === 0) {
    return {
      evidenceStatus: "needs_validation",
      evidenceSamples: 0,
      conservativeReturnedMinutes: null,
    };
  }
  return {
    evidenceStatus: "verified_history",
    evidenceSamples: entries.length,
    conservativeReturnedMinutes: Math.min(...entries.map((entry) => entry.returnedMinutes)),
  };
}

export function buildWeeklyDelegationQueue({
  manifests = [],
  recipes = [],
  plans = [],
  timeReturns = [],
  weeklyTargetMinutes = 480,
  now = new Date(),
  executionEnabled = false,
} = {}) {
  const normalizedManifests = boundedArray(manifests, "manifests");
  const normalizedRecipes = boundedArray(recipes, "recipes");
  const normalizedPlans = boundedArray(plans, "plans");
  const normalizedTimeReturns = boundedArray(timeReturns, "timeReturns");
  const summary = summarizeTimeReturns(normalizedTimeReturns, {
    weeklyTargetMinutes,
    now,
  });
  const remainingMinutes = Math.max(
    0,
    summary.weeklyTargetMinutes - summary.weeklyReturnedMinutes,
  );
  const result = {
    weekStart: summary.weekStart,
    weekEnd: summary.weekEnd,
    weeklyTargetMinutes: summary.weeklyTargetMinutes,
    weeklyReturnedMinutes: summary.weeklyReturnedMinutes,
    remainingMinutes,
    targetMet: remainingMinutes === 0,
    executionEnabled: executionEnabled === true,
    items: [],
    inProgress: [],
    blocked: [],
    projectedVerifiedReturnedMinutes: 0,
    remainingAfterVerifiedQueueMinutes: remainingMinutes,
    evidenceBoundary: "confirmed_recipe_outcomes_only",
    recommendationBoundary: "planning_only_no_execution",
  };
  if (result.targetMet) return result;

  const recipesById = new Map(normalizedRecipes.map((recipe) => [recipe.id, recipe]));
  const activeByProjectRecipe = new Map();
  for (const plan of normalizedPlans) {
    const projectId = text(plan.project_id ?? plan.projectId);
    const recipeId = text(plan.plan?.recipe?.id ?? plan.recipeId);
    if (!projectId || !recipeId || !activePlanStatuses.has(plan.status)) continue;
    const key = `${projectId}\u0000${recipeId}`;
    if (!activeByProjectRecipe.has(key)) activeByProjectRecipe.set(key, []);
    activeByProjectRecipe.get(key).push(plan);
  }

  for (const manifest of normalizedManifests) {
    const projectId = text(manifest?.projectId);
    const projectName = text(manifest?.name);
    if (!projectId || !projectName) continue;
    const selectedRecipeIds = [...new Set(
      (manifest.profile?.selectedRecipeIds ?? []).map(text).filter(Boolean),
    )];
    for (const recipeId of selectedRecipeIds) {
      const recipe = recipesById.get(recipeId);
      if (!recipe) {
        result.blocked.push({
          projectId,
          projectName,
          recipeId,
          reason: "recipe_unavailable",
          disabledCapabilities: [],
        });
        continue;
      }
      const activePlans = activeByProjectRecipe.get(`${projectId}\u0000${recipeId}`) ?? [];
      if (activePlans.length > 0) {
        result.inProgress.push(...activePlans.map((plan) => ({
          projectId,
          projectName,
          recipeId,
          recipeName: recipe.name,
          workPlanId: plan.id,
          status: plan.status,
        })));
        continue;
      }
      const requiredCapabilities = [...new Set(
        (recipe.steps ?? []).map((step) => text(step.capability)).filter(Boolean),
      )];
      const disabledCapabilities = requiredCapabilities.filter(
        (capability) => !ruleAvailable(manifest.capabilities?.[capability], now),
      );
      if (disabledCapabilities.length > 0) {
        result.blocked.push({
          projectId,
          projectName,
          recipeId,
          recipeName: recipe.name,
          reason: "project_capability_disabled",
          disabledCapabilities,
        });
        continue;
      }
      const evidence = evidenceFor(normalizedTimeReturns, projectId, recipeId);
      const approvalRequired = requiredCapabilities.some(
        (capability) => manifest.capabilities?.[capability]?.mode === "approval_required",
      );
      result.items.push({
        projectId,
        projectName,
        recipeId,
        recipeName: recipe.name,
        baselineMinutes: recipe.baselineMinutes,
        baselineMethod: recipe.baselineMethod,
        requiredInputs: (recipe.inputs ?? [])
          .filter((input) => input.required !== false)
          .map((input) => input.name),
        requiredCapabilities,
        approvalRequired,
        executionPath: !result.executionEnabled
          ? "global_execution_disabled"
          : approvalRequired
            ? "approval_required_after_instantiation"
            : "project_policy_after_instantiation",
        ...evidence,
      });
    }
  }

  result.items.sort((left, right) => {
    const leftVerified = left.evidenceStatus === "verified_history" ? 1 : 0;
    const rightVerified = right.evidenceStatus === "verified_history" ? 1 : 0;
    return rightVerified - leftVerified ||
      (right.conservativeReturnedMinutes ?? -1) - (left.conservativeReturnedMinutes ?? -1) ||
      left.projectId.localeCompare(right.projectId) ||
      left.recipeId.localeCompare(right.recipeId);
  });
  result.projectedVerifiedReturnedMinutes = result.items.reduce(
    (total, item) => total + (item.conservativeReturnedMinutes ?? 0),
    0,
  );
  result.remainingAfterVerifiedQueueMinutes = Math.max(
    0,
    remainingMinutes - result.projectedVerifiedReturnedMinutes,
  );
  return result;
}

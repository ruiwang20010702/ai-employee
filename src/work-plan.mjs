import { createHash } from "node:crypto";
import {
  capabilityCatalog,
  evaluatePlan,
  validateProjectManifest,
} from "./capability-policy.mjs";
import { capabilityBudgetForPlan } from "./capability-budget.mjs";

function required(value, name, maxLength = 4_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${name} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function boundedJson(value, name, depth = 0) {
  if (depth > 10) throw new Error(`${name} exceeds maximum nesting depth`);
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => boundedJson(item, name, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} must contain JSON-compatible values`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, boundedJson(item, name, depth + 1)]),
  );
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function recipeBinding(value) {
  if (value == null) return null;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("recipe must be an object");
  }
  const id = required(value.id, "recipe.id", 100);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(id)) {
    throw new Error("recipe.id is invalid");
  }
  const version = Number(value.version);
  const contentHash = value.contentHash == null
    ? null
    : required(value.contentHash, "recipe.contentHash", 64);
  if (contentHash != null && !/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new Error("recipe.contentHash must be a lowercase SHA-256 digest");
  }
  const baselineMinutes = Number(value.baselineMinutes);
  if (version !== 1) throw new Error("recipe.version must be 1");
  if (
    !Number.isSafeInteger(baselineMinutes) ||
    baselineMinutes < 1 ||
    baselineMinutes > 2_400
  ) {
    throw new Error("recipe.baselineMinutes must be between 1 and 2400");
  }
  if (!["measured", "user_confirmed"].includes(value.baselineMethod)) {
    throw new Error("recipe.baselineMethod is invalid");
  }
  const triggerId = value.triggerId == null
    ? null
    : required(value.triggerId, "recipe.triggerId", 100);
  const triggerRunKey = value.triggerRunKey == null
    ? null
    : required(value.triggerRunKey, "recipe.triggerRunKey", 64);
  if (triggerRunKey != null && !/^[a-f0-9]{64}$/u.test(triggerRunKey)) {
    throw new Error("recipe.triggerRunKey is invalid");
  }
  if ((triggerId == null) !== (triggerRunKey == null)) {
    throw new Error("recipe trigger id and run key must be provided together");
  }
  return {
    id,
    version,
    ...(contentHash == null ? {} : { contentHash }),
    baselineMinutes,
    baselineMethod: value.baselineMethod,
    triggerId,
    triggerRunKey,
  };
}

export function validateWorkPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Work plan must be an object");
  }
  if (input.version !== 1) throw new Error("Work plan version must be 1");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("Work plan requires at least one step");
  }
  if (input.steps.length > 30) throw new Error("Work plan cannot exceed 30 steps");
  const seen = new Set();
  const steps = input.steps.map((step, index) => {
    const id = required(step?.id, `steps[${index}].id`, 100);
    if (seen.has(id)) throw new Error(`Duplicate step id: ${id}`);
    seen.add(id);
    const capability = required(step.capability, `steps[${index}].capability`, 100);
    const definition = capabilityCatalog[capability];
    const expectedEvidence = required(
      step.expectedEvidence,
      `steps[${index}].expectedEvidence`,
      2_000,
    );
    if (definition?.sideEffect && !step.rollback) {
      throw new Error(`Side-effect step requires rollback description: ${id}`);
    }
    const inputs = boundedJson(step.inputs ?? {}, `steps[${index}].inputs`);
    if (Buffer.byteLength(JSON.stringify(inputs), "utf8") > 65_536) {
      throw new Error(`steps[${index}].inputs exceeds 65536 bytes`);
    }
    return {
      id,
      capability,
      description: required(step.description, `steps[${index}].description`, 4_000),
      workingDirectory: step.workingDirectory
        ? required(step.workingDirectory, `steps[${index}].workingDirectory`, 4_096)
        : null,
      inputs,
      expectedEvidence,
      rollback: step.rollback
        ? required(step.rollback, `steps[${index}].rollback`, 2_000)
        : null,
    };
  });
  return {
    version: 1,
    projectId: required(input.projectId, "projectId", 200),
    requesterId: required(input.requesterId, "requesterId", 500),
    sourceTaskId: input.sourceTaskId
      ? required(input.sourceTaskId, "sourceTaskId", 200)
      : null,
    ...(input.recipe == null ? {} : { recipe: recipeBinding(input.recipe) }),
    objective: required(input.objective, "objective", 4_000),
    steps,
  };
}

export function assessWorkPlan({ plan, manifest, now = new Date() }) {
  const normalized = validateWorkPlan(plan);
  const authorization = validateProjectManifest(manifest);
  if (normalized.projectId !== authorization.projectId) {
    return { decision: "DENY", reason: "任务计划与项目清单不匹配。" };
  }
  const policy = evaluatePlan({
    manifest: authorization,
    requesterId: normalized.requesterId,
    steps: normalized.steps,
    now,
  });
  const authorizationHash = createHash("sha256")
    .update(JSON.stringify(stable(authorization)))
    .digest("hex");
  const planHash = createHash("sha256")
    .update(JSON.stringify(stable({ plan: normalized, authorization })))
    .digest("hex");
  const assessment = { ...policy, authorizationHash, planHash, plan: normalized };
  return {
    ...assessment,
    capabilityBudget: capabilityBudgetForPlan(assessment, authorization),
  };
}

export function validateWorkPlanRevision({
  currentPlan,
  currentPlanHash,
  assessment,
}) {
  const current = validateWorkPlan(currentPlan);
  if (!assessment?.planHash || !assessment?.plan) {
    throw new Error("Assessed revised work plan is required");
  }
  if (!["ALLOW", "REQUIRE_APPROVAL"].includes(assessment.decision)) {
    throw new Error("Denied work plan cannot replace an existing plan");
  }
  const revised = validateWorkPlan(assessment.plan);
  for (const field of ["projectId", "requesterId", "sourceTaskId"]) {
    if (revised[field] !== current[field]) {
      throw new Error(`Revised work plan cannot change ${field}`);
    }
  }
  if (assessment.planHash === currentPlanHash) {
    throw new Error("Revised work plan must change the approved content");
  }
  return revised;
}

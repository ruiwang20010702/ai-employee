import { createHash } from "node:crypto";
import { validateWorkPlan } from "./work-plan.mjs";

const recipeIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const variablePattern = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/gu;

function required(value, name, maximum = 4_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function stableObject(value, name, depth = 0) {
  if (depth > 10) throw new Error(`${name} exceeds maximum nesting depth`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
    return value;
  }
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item, name, depth + 1));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} must be JSON-compatible`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    required(key, `${name} key`, 100),
    stableObject(item, name, depth + 1),
  ]));
}

export function validateWorkRecipe(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Work recipe must be an object");
  }
  if (input.version !== 1) throw new Error("Work recipe version must be 1");
  const id = required(input.id, "recipe.id", 100);
  if (!recipeIdPattern.test(id)) throw new Error("recipe.id is invalid");
  const inputs = Array.isArray(input.inputs) ? input.inputs.map((field, index) => {
    const name = required(field?.name, `recipe.inputs[${index}].name`, 100);
    if (!/^[a-z][a-zA-Z0-9_]*$/u.test(name)) throw new Error(`Invalid recipe input: ${name}`);
    const type = field.type ?? "string";
    if (!["string", "number", "boolean", "string_list"].includes(type)) {
      throw new Error(`Unsupported recipe input type: ${type}`);
    }
    return {
      name,
      type,
      required: field.required !== false,
      secret: field.secret === true,
      description: required(field.description ?? name, `recipe.inputs[${index}].description`, 500),
    };
  }) : [];
  if (new Set(inputs.map((field) => field.name)).size !== inputs.length) {
    throw new Error("Recipe input names must be unique");
  }
  if (inputs.some((field) => field.secret)) {
    throw new Error("Recipe v1 cannot persist secret inputs in a work plan");
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 30) {
    throw new Error("Work recipe requires 1-30 steps");
  }
  const baselineMinutes = Number(input.baselineMinutes);
  if (!Number.isSafeInteger(baselineMinutes) || baselineMinutes < 1 || baselineMinutes > 2_400) {
    throw new Error("recipe.baselineMinutes must be between 1 and 2400");
  }
  return {
    version: 1,
    id,
    name: required(input.name, "recipe.name", 200),
    description: required(input.description, "recipe.description", 1_000),
    category: required(input.category, "recipe.category", 100),
    objective: required(input.objective, "recipe.objective", 4_000),
    baselineMinutes,
    baselineMethod: input.baselineMethod === "measured" ? "measured" : "user_confirmed",
    inputs,
    steps: stableObject(input.steps, "recipe.steps"),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function workRecipeRevision(input) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(validateWorkRecipe(input))))
    .digest("hex");
}

function normalizeInput(field, value) {
  if (value == null || value === "") {
    if (field.required) throw new Error(`Missing recipe input: ${field.name}`);
    return "";
  }
  if (field.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Recipe input must be a number: ${field.name}`);
    return number;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Recipe input must be boolean: ${field.name}`);
    return value;
  }
  if (field.type === "string_list") {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      throw new Error(`Recipe input must be a non-empty string list: ${field.name}`);
    }
    const normalized = [...new Set(value.map((item) => String(item ?? "").trim()))];
    if (normalized.some((item) => !item || item.length > 500)) {
      throw new Error(`Recipe string list item is invalid: ${field.name}`);
    }
    return normalized;
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 10_000) {
    throw new Error(`Recipe input is invalid: ${field.name}`);
  }
  return normalized;
}

function render(value, values) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([a-z][a-zA-Z0-9_]*)\}\}$/u);
    if (exact) {
      if (!Object.hasOwn(values, exact[1])) {
        throw new Error(`Unknown recipe variable: ${exact[1]}`);
      }
      return values[exact[1]];
    }
    const output = value.replace(variablePattern, (_match, name) => {
      if (!Object.hasOwn(values, name)) {
        throw new Error(`Unknown recipe variable: ${name}`);
      }
      return String(values[name]);
    });
    if (/\{\{[^}]+\}\}/u.test(output)) throw new Error("Recipe contains an unresolved variable");
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => render(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, values)]));
  }
  return value;
}

export function instantiateWorkRecipe(recipeInput, {
  projectId,
  requesterId,
  sourceTaskId = null,
  projectRoot = null,
  values = {},
  trigger = null,
}) {
  const recipe = validateWorkRecipe(recipeInput);
  const contentHash = workRecipeRevision(recipe);
  const normalizedValues = {
    projectRoot: String(projectRoot ?? "").trim(),
    ...Object.fromEntries(
      recipe.inputs.map((field) => [field.name, normalizeInput(field, values[field.name])]),
    ),
  };
  const plan = validateWorkPlan({
    version: 1,
    projectId,
    requesterId,
    sourceTaskId,
    recipe: {
      id: recipe.id,
      version: recipe.version,
      contentHash,
      baselineMinutes: recipe.baselineMinutes,
      baselineMethod: recipe.baselineMethod,
      ...(trigger == null ? {} : {
        triggerId: String(trigger.id ?? "").trim(),
        triggerRunKey: String(trigger.runKey ?? "").trim(),
      }),
    },
    objective: render(recipe.objective, normalizedValues),
    steps: render(recipe.steps, normalizedValues),
  });
  return {
    recipeId: recipe.id,
    plan,
    timeReturnProposal: {
      baselineMinutes: recipe.baselineMinutes,
      baselineMethod: recipe.baselineMethod,
      status: "proposed",
    },
  };
}

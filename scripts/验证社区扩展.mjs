#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capabilityCatalog,
  prohibitedCapabilities,
} from "../src/capability-policy.mjs";
import { validateExtensionManifest } from "../src/extension-manifest.mjs";
import { isMainModule } from "../src/main-module.mjs";
import { containsCredentialMaterial } from "../src/memory-candidate.mjs";
import { instantiateWorkRecipe, validateWorkRecipe } from "../src/work-recipe.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const maximumFileBytes = 128 * 1024;
const maximumFiles = 100;
const credentialField = /(?:password|passwd|pwd|token|secret|api[_-]?key|credential|cookie|authorization)/iu;

function plainObject(value, name) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  plainObject(value, name);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unsupported fields`);
}

function assertCredentialFree(value, name, depth = 0) {
  if (depth > 10) throw new Error(`${name} exceeds maximum nesting depth`);
  if (typeof value === "string") {
    if (containsCredentialMaterial(value)) {
      throw new Error(`${name} contains credential material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertCredentialFree(item, `${name}[${index}]`, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (credentialField.test(key)) {
        throw new Error(`${name} contains a credential field`);
      }
      assertCredentialFree(item, `${name}.${key}`, depth + 1);
    }
  }
}

async function readJsonFile(path, kind) {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${kind} file does not exist`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${kind} path must be a regular JSON file`);
  }
  if (stat.size === 0 || stat.size > maximumFileBytes) {
    throw new Error(`${kind} file must contain 1-${maximumFileBytes} bytes`);
  }
  const canonical = await realpath(absolute);
  return JSON.parse(await readFile(canonical, "utf8"));
}

async function jsonFiles(directory, kind) {
  const absolute = resolve(directory);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${kind} directory must be a real directory`);
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  const jsonEntries = entries.filter((entry) => entry.name.endsWith(".json"));
  if (jsonEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error(`${kind} directory contains a non-regular JSON entry`);
  }
  return jsonEntries.map((entry) => join(absolute, entry.name)).sort();
}

function sampleValue(field) {
  if (field.type === "number") return 1;
  if (field.type === "boolean") return false;
  if (field.type === "string_list") return ["example"];
  return "example";
}

export function validateCommunityRecipe(input) {
  exactKeys(input, new Set([
    "version", "id", "name", "description", "category", "objective",
    "baselineMinutes", "baselineMethod", "inputs", "steps",
  ]), "recipe");
  if (!Array.isArray(input.inputs)) throw new Error("recipe.inputs must be an array");
  for (const [index, field] of input.inputs.entries()) {
    exactKeys(field, new Set(["name", "type", "required", "secret", "description"]), `recipe.inputs[${index}]`);
    if (credentialField.test(String(field.name ?? ""))) {
      throw new Error(`recipe.inputs[${index}] cannot request credentials`);
    }
  }
  if (Array.isArray(input.steps)) {
    for (const [index, step] of input.steps.entries()) {
      exactKeys(step, new Set([
        "id", "capability", "description", "workingDirectory", "inputs",
        "expectedEvidence", "rollback",
      ]), `recipe.steps[${index}]`);
      if (!capabilityCatalog[step.capability] || prohibitedCapabilities.has(step.capability)) {
        throw new Error(`recipe.steps[${index}] capability is not registered`);
      }
      if (step.workingDirectory != null && step.workingDirectory !== "{{projectRoot}}") {
        throw new Error(`recipe.steps[${index}].workingDirectory must use {{projectRoot}}`);
      }
      assertCredentialFree(step.inputs ?? {}, `recipe.steps[${index}].inputs`);
    }
  }
  assertCredentialFree({
    name: input.name,
    description: input.description,
    objective: input.objective,
  }, "recipe text");
  const recipe = validateWorkRecipe(input);
  const instantiated = instantiateWorkRecipe(recipe, {
    projectId: "community-validation",
    requesterId: "community-contributor",
    projectRoot: "/workspace/foursday-community-validation",
    values: Object.fromEntries(recipe.inputs.map((field) => [field.name, sampleValue(field)])),
  });
  return {
    id: recipe.id,
    steps: instantiated.plan.steps.length,
    capabilities: [...new Set(instantiated.plan.steps.map((step) => step.capability))].sort(),
    sideEffectSteps: instantiated.plan.steps.filter(
      (step) => capabilityCatalog[step.capability].sideEffect,
    ).length,
  };
}

export function validateCommunityAdapter(input) {
  exactKeys(input, new Set([
    "version", "id", "name", "platform", "contract", "contractVersion",
    "status", "permissions", "runtimeSecrets", "guarantees",
  ]), "adapter manifest");
  exactKeys(input.guarantees, new Set([
    "allowlist", "idempotency", "humanTakeover", "targetReadback", "unknownOutcome",
  ]), "adapter manifest guarantees");
  assertCredentialFree({
    name: input.name,
    platform: input.platform,
    permissions: input.permissions,
  }, "adapter manifest");
  const manifest = validateExtensionManifest(input);
  return { id: manifest.id, contract: manifest.contract, status: manifest.status };
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const recipePaths = [];
  const adapterPaths = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--recipe", "--adapter"].includes(flag) || !args[index + 1]) {
      throw new Error("Usage: npm run extensions:validate -- [--recipe path.json] [--adapter path.json]");
    }
    (flag === "--recipe" ? recipePaths : adapterPaths).push(args[index + 1]);
    index += 1;
  }
  return { help: false, recipePaths, adapterPaths };
}

export async function validateCommunityExtensions({
  recipePaths = [],
  adapterPaths = [],
  root = projectRoot,
} = {}) {
  let recipes = recipePaths;
  let adapters = adapterPaths;
  if (recipes.length === 0 && adapters.length === 0) {
    [recipes, adapters] = await Promise.all([
      jsonFiles(join(root, "examples", "recipes"), "Recipe"),
      jsonFiles(join(root, "examples", "adapters"), "Adapter"),
    ]);
  }
  if (recipes.length + adapters.length === 0 || recipes.length + adapters.length > maximumFiles) {
    throw new Error(`Community validation requires 1-${maximumFiles} JSON files`);
  }
  const recipeResults = [];
  for (const path of recipes) {
    recipeResults.push(validateCommunityRecipe(await readJsonFile(path, "Recipe")));
  }
  const adapterResults = [];
  for (const path of adapters) {
    adapterResults.push(validateCommunityAdapter(await readJsonFile(path, "Adapter")));
  }
  const ids = [...recipeResults, ...adapterResults].map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Community extension IDs must be unique");
  return {
    valid: true,
    recipes: recipeResults.length,
    adapters: adapterResults.length,
    recipeIds: recipeResults.map((item) => item.id).sort(),
    adapterIds: adapterResults.map((item) => item.id).sort(),
    capabilities: [...new Set(recipeResults.flatMap((item) => item.capabilities))].sort(),
    sideEffectSteps: recipeResults.reduce((total, item) => total + item.sideEffectSteps, 0),
    credentialFilesRead: 0,
    externalActions: 0,
  };
}

export async function runCommunityExtensionValidation({
  args = process.argv.slice(2),
  output = process.stdout,
} = {}) {
  const parsed = parseArguments(args);
  if (parsed.help) {
    output.write([
      "Validate credential-free Foursday community recipes and adapter manifests.",
      "",
      "Usage:",
      "  npm run extensions:validate",
      "  npm run extensions:validate -- --recipe examples/recipes/my-recipe.json",
      "  npm run extensions:validate -- --adapter examples/adapters/my-adapter.json",
      "",
    ].join("\n"));
    return { help: true };
  }
  const result = await validateCommunityExtensions(parsed);
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runCommunityExtensionValidation();

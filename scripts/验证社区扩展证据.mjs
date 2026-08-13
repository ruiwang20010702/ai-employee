#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";
import {
  validateCommunityAdapter,
  validateCommunityRecipe,
} from "./验证社区扩展.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const maximumManifestBytes = 128 * 1024;
const maximumEntries = 20;

function exactSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("Community extension evidence requires a complete candidate SHA");
  }
  return normalized;
}

function plainObject(value, name) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${name} must be a JSON object`);
  return value;
}

function exactKeys(value, allowed, name) {
  plainObject(value, name);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function extensionPath(value, kind) {
  const normalized = String(value ?? "").trim();
  const directory = kind === "recipe" ? "recipes" : "adapters";
  const pattern = new RegExp(`^examples/${directory}/[a-z0-9][a-z0-9._-]{0,199}\\.json$`, "u");
  if (!pattern.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Community ${kind} evidence path is invalid`);
  }
  return normalized;
}

async function regularRepositoryFile(root, configured, kind) {
  const canonicalRoot = await realpath(resolve(root));
  const parts = configured.split("/");
  let current = canonicalRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Community ${kind} evidence path cannot contain symbolic links`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Community ${kind} evidence parent must be a directory`);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(`Community ${kind} evidence must point to a regular file`);
    }
  }
  const canonicalFile = await realpath(current);
  const fileStat = await lstat(canonicalFile);
  if (fileStat.size === 0 || fileStat.size > maximumManifestBytes) {
    throw new Error(`Community ${kind} evidence file size is invalid`);
  }
  const rel = relative(canonicalRoot, canonicalFile);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Community ${kind} evidence must stay inside the repository`);
  }
  return canonicalFile;
}

function argumentsFor(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const allowed = new Set(["--manifest", "--sha"]);
  const parsed = { help: false, manifestPath: null, candidateSha: null };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      throw new Error("Usage: npm run extensions:evidence:verify -- --manifest path.json --sha <40-character-sha>");
    }
    if (flag === "--manifest") parsed.manifestPath = value;
    if (flag === "--sha") parsed.candidateSha = value;
    index += 1;
  }
  if (!parsed.manifestPath || !parsed.candidateSha) {
    throw new Error("Usage: npm run extensions:evidence:verify -- --manifest path.json --sha <40-character-sha>");
  }
  return parsed;
}

export async function verifyCommunityExtensionEvidence(manifestPath, {
  candidateSha,
  root = projectRoot,
} = {}) {
  const expectedSha = exactSha(candidateSha);
  const absoluteManifest = resolve(manifestPath);
  const manifestStat = await lstat(absoluteManifest);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size === 0 ||
    manifestStat.size > maximumManifestBytes
  ) throw new Error("Community extension evidence manifest must be a bounded regular file");
  const manifest = JSON.parse(await readFile(await realpath(absoluteManifest), "utf8"));
  exactKeys(manifest, new Set(["schema", "candidateSha", "entries"]), "manifest");
  if (manifest.schema !== "foursday-community-extension-evidence/v1") {
    throw new Error("Community extension evidence manifest schema is invalid");
  }
  if (exactSha(manifest.candidateSha) !== expectedSha) {
    throw new Error("Community extension evidence candidate SHA does not match");
  }
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.length > maximumEntries
  ) throw new Error(`Community extension evidence requires 1-${maximumEntries} entries`);

  const entries = [];
  for (const [index, raw] of manifest.entries.entries()) {
    exactKeys(
      raw,
      new Set(["kind", "extensionId", "extensionPath", "pullNumber"]),
      `entries[${index}]`,
    );
    if (!new Set(["recipe", "adapter"]).has(raw.kind)) {
      throw new Error(`entries[${index}].kind must be recipe or adapter`);
    }
    const configuredPath = extensionPath(raw.extensionPath, raw.kind);
    const file = await regularRepositoryFile(root, configuredPath, raw.kind);
    const content = await readFile(file);
    const parsedExtension = JSON.parse(content.toString("utf8"));
    const validation = raw.kind === "recipe"
      ? validateCommunityRecipe(parsedExtension)
      : validateCommunityAdapter(parsedExtension);
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const verifiedId = validation.id;
    if (raw.extensionId !== verifiedId) {
      throw new Error(`entries[${index}].extensionId does not match the validated file`);
    }
    if (!Number.isSafeInteger(raw.pullNumber) || raw.pullNumber < 1 || raw.pullNumber > 1_000_000_000) {
      throw new Error(`entries[${index}].pullNumber is invalid`);
    }
    entries.push(Object.freeze({
      kind: raw.kind,
      extensionId: verifiedId,
      extensionPath: configuredPath,
      contentSha256,
      pullNumber: raw.pullNumber,
    }));
  }
  for (const [values, name] of [
    [entries.map((entry) => entry.extensionId), "extension IDs"],
    [entries.map((entry) => entry.extensionPath), "extension paths"],
    [entries.map((entry) => entry.pullNumber), "pull request numbers"],
  ]) {
    if (new Set(values).size !== values.length) {
      throw new Error(`Community extension evidence ${name} must be unique`);
    }
  }
  return Object.freeze({
    valid: true,
    schema: manifest.schema,
    candidateSha: expectedSha,
    verifiedCommunityRecipesOrAdapters: entries.length,
    recipes: entries.filter((entry) => entry.kind === "recipe").length,
    adapters: entries.filter((entry) => entry.kind === "adapter").length,
    entries: Object.freeze(entries),
    localIntegrityVerified: true,
    targetReadbackReverificationRequired: true,
    contributorIdentitiesEmitted: false,
  });
}

export async function runCommunityExtensionEvidenceVerification({
  args = process.argv.slice(2),
  output = process.stdout,
  verify = verifyCommunityExtensionEvidence,
} = {}) {
  const parsed = argumentsFor(args);
  if (parsed.help) {
    output.write([
      "Verify a versioned Foursday community extension evidence manifest.",
      "",
      "Usage:",
      "  npm run extensions:evidence:verify -- --manifest path.json --sha <40-character-sha>",
      "",
    ].join("\n"));
    return { help: true };
  }
  const result = await verify(parsed.manifestPath, { candidateSha: parsed.candidateSha });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) await runCommunityExtensionEvidenceVerification();

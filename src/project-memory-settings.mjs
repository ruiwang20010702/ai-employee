import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateProjectManifest } from "./capability-policy.mjs";
import { historicalProjectSourceSnapshot } from "./historical-project-import.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";

const allowedModes = new Set(["disabled", "approval_required", "automatic"]);
const allowedInputKeys = new Set([
  "mode",
  "sourcePaths",
  "allowedFactKeyPrefixes",
  "maxRetentionDays",
  "autoConfirm",
  "expiresAt",
]);
const prefixPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.$/u;
const maximumAuthorizationDays = 365;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestWithoutPath(project) {
  const { manifestPath: _manifestPath, ...manifest } = project ?? {};
  return validateProjectManifest(manifest);
}

function normalizedUniqueStrings(value, name, maximum) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const normalized = [...new Set(value.map((item) => String(item ?? "").trim()))];
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    normalized.some((item) => !item)
  ) {
    throw new Error(`${name} must contain 1-${maximum} unique values`);
  }
  return normalized;
}

function normalizedExpiry(value, now) {
  const expiresAt = new Date(String(value ?? ""));
  const maximum = new Date(now.getTime() + maximumAuthorizationDays * 86_400_000);
  if (
    !value ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt > maximum
  ) {
    throw new Error(
      `project memory authorization expiresAt must be in the next ${maximumAuthorizationDays} days`,
    );
  }
  return expiresAt.toISOString();
}

function normalizeSettings(input, project, now) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Project memory settings must be an object");
  }
  const unknownKeys = Object.keys(input).filter((key) => !allowedInputKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown project memory settings: ${unknownKeys.join(", ")}`);
  }
  const mode = String(input.mode ?? "").trim();
  if (!allowedModes.has(mode)) throw new Error("Project memory settings mode is invalid");
  if (mode === "disabled") return { mode: "disabled" };
  const sourcePaths = normalizedUniqueStrings(input.sourcePaths, "sourcePaths", 20);
  const allowedFactKeyPrefixes = normalizedUniqueStrings(
    input.allowedFactKeyPrefixes,
    "allowedFactKeyPrefixes",
    20,
  );
  if (allowedFactKeyPrefixes.some((prefix) => !prefixPattern.test(prefix))) {
    throw new Error("allowedFactKeyPrefixes must use lowercase dotted prefixes ending in .");
  }
  const maxRetentionDays = Number(input.maxRetentionDays);
  const projectRetentionDays = Number(project.profile?.memoryScope?.retentionDays ?? 0);
  if (
    !Number.isSafeInteger(maxRetentionDays) ||
    maxRetentionDays < 1 ||
    maxRetentionDays > 365 ||
    maxRetentionDays > projectRetentionDays
  ) {
    throw new Error("maxRetentionDays must fit the project memory retention scope");
  }
  if (typeof input.autoConfirm !== "boolean") {
    throw new Error("autoConfirm must be boolean");
  }
  if (input.autoConfirm && mode !== "automatic") {
    throw new Error("autoConfirm requires automatic mode");
  }
  return {
    mode,
    expiresAt: normalizedExpiry(input.expiresAt, now),
    maxRuns: null,
    timeoutMs: 120_000,
    allowedFactKeyPrefixes,
    maxRetentionDays,
    sourcePaths,
    autoConfirm: input.autoConfirm,
  };
}

function settingsView(rule) {
  if (!rule || rule.mode === "disabled") {
    return {
      mode: "disabled",
      expiresAt: null,
      sourcePaths: [],
      allowedFactKeyPrefixes: [],
      maxRetentionDays: null,
      autoConfirm: false,
    };
  }
  return {
    mode: rule.mode,
    expiresAt: rule.expiresAt ?? null,
    sourcePaths: [...(rule.sourcePaths ?? [])],
    allowedFactKeyPrefixes: [...(rule.allowedFactKeyPrefixes ?? [])],
    maxRetentionDays: rule.maxRetentionDays,
    autoConfirm: rule.autoConfirm === true,
  };
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function changeSummary(current, proposed) {
  const addedSources = setDifference(proposed.sourcePaths, current.sourcePaths);
  const removedSources = setDifference(current.sourcePaths, proposed.sourcePaths);
  const addedPrefixes = setDifference(
    proposed.allowedFactKeyPrefixes,
    current.allowedFactKeyPrefixes,
  );
  const removedPrefixes = setDifference(
    current.allowedFactKeyPrefixes,
    proposed.allowedFactKeyPrefixes,
  );
  const expiryExtended = Boolean(
    current.expiresAt && proposed.expiresAt &&
    new Date(proposed.expiresAt) > new Date(current.expiresAt),
  );
  const expansion = current.mode === "disabled" && proposed.mode !== "disabled" ||
    current.mode === "approval_required" && proposed.mode === "automatic" ||
    !current.autoConfirm && proposed.autoConfirm ||
    addedSources.length > 0 ||
    addedPrefixes.length > 0 ||
    (proposed.maxRetentionDays ?? 0) > (current.maxRetentionDays ?? 0) ||
    expiryExtended;
  return {
    authorizationExpansion: expansion,
    addedSources,
    removedSources,
    addedPrefixes,
    removedPrefixes,
    modeChanged: current.mode !== proposed.mode,
    retentionChanged: current.maxRetentionDays !== proposed.maxRetentionDays,
    expiryChanged: current.expiresAt !== proposed.expiresAt,
    autoConfirmChanged: current.autoConfirm !== proposed.autoConfirm,
  };
}

function authorizationConfirmation(digest) {
  return `MEMORY-AUTH-${digest.slice(0, 12).toUpperCase()}`;
}

export async function previewProjectMemorySettings({
  project,
  settings,
  globalCapabilities = new Set(),
  now = new Date(),
  sourceSnapshot = historicalProjectSourceSnapshot,
}) {
  const currentManifest = manifestWithoutPath(project);
  const nextRule = normalizeSettings(settings, currentManifest, now);
  const nextManifest = validateProjectManifest({
    ...currentManifest,
    capabilities: {
      ...currentManifest.capabilities,
      project_memory_proposal: nextRule,
    },
  });
  const current = settingsView(currentManifest.capabilities.project_memory_proposal);
  const proposed = settingsView(nextManifest.capabilities.project_memory_proposal);
  const sources = proposed.mode === "disabled"
    ? { sources: [], totalBytes: 0, digest: sha256("[]") }
    : await sourceSnapshot({
        rootDirectory: nextManifest.rootDirectory,
        sources: proposed.sourcePaths.map((path, index) => ({
          id: `source_${index}`,
          path,
        })),
      });
  const currentManifestSha256 = sha256(JSON.stringify(currentManifest));
  const nextManifestSha256 = sha256(JSON.stringify(nextManifest));
  const payload = {
    schema: "foursday-project-memory-settings-preview/v1",
    projectId: currentManifest.projectId,
    currentManifestSha256,
    nextManifestSha256,
    current,
    proposed,
    sourceDigest: sources.digest,
  };
  const digest = sha256(JSON.stringify(payload));
  const globalGateEnabled = globalCapabilities instanceof Set &&
    globalCapabilities.has("project_memory_proposal");
  return {
    ...payload,
    digest,
    confirmation: authorizationConfirmation(digest),
    changes: changeSummary(current, proposed),
    sources: sources.sources.map((source) => ({
      path: source.path,
      bytes: source.bytes,
      sha256: source.sha256,
    })),
    sourceBytes: sources.totalBytes,
    globalGateEnabled,
    effectiveAutomaticSync: globalGateEnabled && proposed.mode === "automatic",
    effectiveAutomaticConfirmation: globalGateEnabled &&
      proposed.mode === "automatic" && proposed.autoConfirm,
    databaseWrite: false,
    externalSystemsTouched: false,
  };
}

async function assertSafeManifestTarget(projectsDirectory, project) {
  const canonicalDirectory = await realpath(projectsDirectory);
  const expectedName = `${project.projectId}.json`;
  const lexicalManifest = resolve(project.manifestPath ?? "");
  if (basename(lexicalManifest) !== expectedName) {
    throw new Error("Project manifest filename does not match the project id");
  }
  const canonicalManifest = await realpath(lexicalManifest);
  const expectedManifest = join(canonicalDirectory, expectedName);
  if (canonicalManifest !== expectedManifest) {
    throw new Error("Project manifest must remain inside the configured directory");
  }
  const metadata = await lstat(canonicalManifest);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Project manifest must be a regular file");
  }
  return { canonicalDirectory, canonicalManifest, metadata };
}

async function atomicWriteManifest({ directory, destination, content, expected }) {
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const currentMetadata = await lstat(destination);
    const currentContent = await readFile(destination);
    if (
      !currentMetadata.isFile() ||
      currentMetadata.isSymbolicLink() ||
      currentMetadata.dev !== expected.metadata.dev ||
      currentMetadata.ino !== expected.metadata.ino ||
      currentMetadata.size !== expected.metadata.size ||
      currentMetadata.mtimeMs !== expected.metadata.mtimeMs ||
      sha256(currentContent) !== expected.contentSha256
    ) {
      throw new Error("Project manifest changed after the settings preview");
    }
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function applyProjectMemorySettings({
  projectId,
  settings,
  digest,
  confirmation,
  projectsDirectory,
  globalCapabilities = new Set(),
  now = new Date(),
  manifestLoader = loadProjectManifests,
}) {
  const projects = await manifestLoader(projectsDirectory);
  const project = projects.get(projectId);
  if (!project) throw new Error("Project was not found");
  const target = await assertSafeManifestTarget(projectsDirectory, project);
  const before = await readFile(target.canonicalManifest);
  const preview = await previewProjectMemorySettings({
    project,
    settings,
    globalCapabilities,
    now,
  });
  if (digest !== preview.digest || confirmation !== preview.confirmation) {
    throw new Error("Project memory settings changed; review the current preview again");
  }
  const currentManifest = manifestWithoutPath(project);
  const nextManifest = validateProjectManifest({
    ...currentManifest,
    capabilities: {
      ...currentManifest.capabilities,
      project_memory_proposal: normalizeSettings(settings, currentManifest, now),
    },
  });
  await atomicWriteManifest({
    directory: target.canonicalDirectory,
    destination: target.canonicalManifest,
    content: `${JSON.stringify(nextManifest, null, 2)}\n`,
    expected: {
      metadata: target.metadata,
      contentSha256: sha256(before),
    },
  });
  return {
    schema: "foursday-project-memory-settings-result/v1",
    projectId,
    manifestSha256: preview.nextManifestSha256,
    settings: preview.proposed,
    effectiveAutomaticSync: preview.effectiveAutomaticSync,
    effectiveAutomaticConfirmation: preview.effectiveAutomaticConfirmation,
    databaseWrite: false,
    projectManifestWrite: true,
    externalSystemsTouched: false,
  };
}

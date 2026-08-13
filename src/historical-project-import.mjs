import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  containsCredentialMaterial,
  containsSensitivePersonMaterial,
} from "./memory-candidate.mjs";
import { memoryFactKey } from "./memory-conflicts.mjs";
import { buildProjectOnboardingDraft } from "./project-onboarding.mjs";

export const historicalProjectImportSchema = "foursday-historical-project-import/v1";
export const historicalProjectImportPreviewSchema =
  "foursday-historical-project-import-preview/v1";

const sourceIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const factKeyPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/u;
const allowedTypes = new Set(["project", "principle"]);
const allowedSensitivities = new Set(["public", "internal", "confidential"]);
const maximumSources = 20;
const maximumCandidates = 100;
const maximumSourceBytes = 2 * 1024 * 1024;
const maximumTotalSourceBytes = 10 * 1024 * 1024;

function requiredText(value, name, maximum = 1_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedQuote(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

function isWithinRoot(root, path) {
  const relation = relative(root, path);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation);
}

function safeRelativePath(value, name) {
  const path = requiredText(value, name, 2_000).replaceAll("\\", "/");
  if (
    isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${name} must be a normalized relative path`);
  }
  return path;
}

function normalizedExistingProject(existingProject) {
  if (!existingProject) return null;
  const { manifestPath: _manifestPath, ...manifest } = existingProject;
  return manifest;
}

function sameProjectIdentity(existing, incoming) {
  return existing.projectId === incoming.projectId &&
    existing.name === incoming.name &&
    existing.rootDirectory === incoming.rootDirectory &&
    JSON.stringify(existing.requesters) === JSON.stringify(incoming.requesters) &&
    JSON.stringify(existing.profile) === JSON.stringify(incoming.profile);
}

function comparableMemories(existingMemories, candidate, now) {
  return existingMemories.filter((memory) =>
    memory.deleted_at == null &&
    ["proposed", "confirmed"].includes(memory.status) &&
    memory.project_id === candidate.projectId &&
    memory.type === candidate.type &&
    memory.subject === candidate.subject &&
    memoryFactKey(memory) === candidate.factKey &&
    (!memory.expires_at || new Date(memory.expires_at) > now)
  );
}

function normalizeBundle(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Historical project import must be an object");
  }
  if (input.schema !== historicalProjectImportSchema) {
    throw new Error(`Historical project import schema must be ${historicalProjectImportSchema}`);
  }
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > maximumSources) {
    throw new Error(`sources must contain 1-${maximumSources} items`);
  }
  if (!Array.isArray(input.memories) || input.memories.length > maximumCandidates) {
    throw new Error(`memories must contain at most ${maximumCandidates} items`);
  }
  return input;
}

async function inspectSources({
  rootDirectory,
  sources,
  realpathFn,
  lstatFn,
  readFileFn,
}) {
  const byId = new Map();
  const inspected = [];
  let totalBytes = 0;
  for (const [index, raw] of sources.entries()) {
    const id = requiredText(raw?.id, `sources[${index}].id`, 100);
    if (!sourceIdPattern.test(id)) {
      throw new Error(`sources[${index}].id is invalid`);
    }
    if (byId.has(id)) throw new Error(`Duplicate source id: ${id}`);
    const path = safeRelativePath(raw?.path, `sources[${index}].path`);
    const lexicalPath = resolve(rootDirectory, path);
    if (!isWithinRoot(rootDirectory, lexicalPath)) {
      throw new Error(`sources[${index}].path is outside the project root`);
    }
    const metadata = await lstatFn(lexicalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`sources[${index}].path must be a regular file`);
    }
    const canonicalPath = await realpathFn(lexicalPath);
    if (canonicalPath !== lexicalPath || !isWithinRoot(rootDirectory, canonicalPath)) {
      throw new Error(`sources[${index}].path must not traverse a symbolic link`);
    }
    if (metadata.size > maximumSourceBytes) {
      throw new Error(`sources[${index}].path exceeds ${maximumSourceBytes} bytes`);
    }
    totalBytes += metadata.size;
    if (totalBytes > maximumTotalSourceBytes) {
      throw new Error(`Historical sources exceed ${maximumTotalSourceBytes} bytes`);
    }
    const loaded = await readFileFn(canonicalPath);
    const content = Buffer.isBuffer(loaded) ? loaded : Buffer.from(loaded);
    const finalMetadata = await lstatFn(lexicalPath);
    const finalCanonicalPath = await realpathFn(lexicalPath);
    if (
      !finalMetadata.isFile() ||
      finalMetadata.isSymbolicLink() ||
      finalCanonicalPath !== lexicalPath ||
      finalCanonicalPath !== canonicalPath ||
      finalMetadata.dev !== metadata.dev ||
      finalMetadata.ino !== metadata.ino ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ctimeMs !== metadata.ctimeMs
    ) {
      throw new Error(`sources[${index}].path changed while it was being read`);
    }
    if (content.includes(0)) {
      throw new Error(`sources[${index}].path must be a text file`);
    }
    let sourceText;
    try {
      sourceText = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error(`sources[${index}].path must use valid UTF-8 text`);
    }
    const item = {
      id,
      path,
      bytes: content.length,
      sha256: sha256(content),
      normalizedContent: normalizedQuote(sourceText),
      content,
    };
    byId.set(id, item);
    inspected.push({ id, path, bytes: item.bytes, sha256: item.sha256 });
  }
  return { byId, inspected, totalBytes };
}

export async function loadHistoricalProjectSourceContents({
  rootDirectory,
  sources,
  realpathFn = realpath,
  lstatFn = lstat,
  readFileFn = readFile,
}) {
  const inspected = await inspectSources({
    rootDirectory,
    sources,
    realpathFn,
    lstatFn,
    readFileFn,
  });
  return {
    sources: inspected.inspected.map((source) => ({
      ...source,
      content: Buffer.from(inspected.byId.get(source.id).content),
    })),
    totalBytes: inspected.totalBytes,
  };
}

export async function historicalProjectSourceSnapshot({
  rootDirectory,
  sources,
  realpathFn = realpath,
  lstatFn = lstat,
  readFileFn = readFile,
}) {
  const inspected = await inspectSources({
    rootDirectory,
    sources,
    realpathFn,
    lstatFn,
    readFileFn,
  });
  return {
    sources: inspected.inspected,
    totalBytes: inspected.totalBytes,
    digest: sha256(JSON.stringify(inspected.inspected)),
  };
}

function normalizeCandidate(raw, index, { projectId, retentionDays, sources }) {
  const type = requiredText(raw?.type, `memories[${index}].type`, 20);
  const statement = requiredText(raw?.statement, `memories[${index}].statement`, 1_000)
    .replace(/\s+/gu, " ");
  const factKey = requiredText(raw?.factKey, `memories[${index}].factKey`, 120);
  const sourceId = requiredText(raw?.sourceId, `memories[${index}].sourceId`, 100);
  const sourceQuote = normalizedQuote(
    requiredText(raw?.sourceQuote, `memories[${index}].sourceQuote`, 1_000),
  );
  const sensitivity = raw?.sensitivity ?? "internal";
  const confidence = Number(raw?.confidence ?? 1);
  const candidateRetentionDays = Number(raw?.retentionDays ?? retentionDays);
  if (!allowedTypes.has(type)) throw new Error(`memories[${index}].type is unsupported`);
  if (!factKeyPattern.test(factKey)) throw new Error(`memories[${index}].factKey is invalid`);
  if (!allowedSensitivities.has(sensitivity)) {
    throw new Error(`memories[${index}].sensitivity is invalid`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`memories[${index}].confidence must be between 0 and 1`);
  }
  if (
    !Number.isSafeInteger(candidateRetentionDays) ||
    candidateRetentionDays < 1 ||
    candidateRetentionDays > retentionDays
  ) {
    throw new Error(
      `memories[${index}].retentionDays must be between 1 and the project limit`,
    );
  }
  const source = sources.get(sourceId);
  if (!source) throw new Error(`memories[${index}].sourceId was not declared`);
  const skipReasons = [];
  if (!source.normalizedContent.includes(sourceQuote)) skipReasons.push("source_quote_not_found");
  if (containsCredentialMaterial(statement) || containsCredentialMaterial(sourceQuote)) {
    skipReasons.push("credential_material");
  }
  if (containsSensitivePersonMaterial(statement) || containsSensitivePersonMaterial(sourceQuote)) {
    skipReasons.push("sensitive_person_material");
  }
  return {
    index,
    type,
    subject: projectId,
    projectId,
    statement,
    factKey,
    sensitivity,
    confidence,
    retentionDays: candidateRetentionDays,
    source: {
      id: source.id,
      path: source.path,
      sha256: source.sha256,
      quoteSha256: sha256(sourceQuote),
    },
    skipReasons: [...new Set(skipReasons)],
  };
}

function previewDigestPayload({ manifest, projectAction, sources, candidates, skipped }) {
  return {
    schema: historicalProjectImportPreviewSchema,
    manifest,
    projectAction,
    sources,
    candidates,
    skipped,
  };
}

export function historicalProjectImportConfirmation(digest) {
  if (!/^[a-f0-9]{64}$/u.test(String(digest ?? ""))) {
    throw new Error("Historical project import digest is invalid");
  }
  return `IMPORT-${digest.slice(0, 12).toUpperCase()}`;
}

export async function buildHistoricalProjectImportPreview(input, {
  existingProject = null,
  existingMemories = [],
  now = new Date(),
  realpathFn = realpath,
  lstatFn = lstat,
  readFileFn = readFile,
  onboardingBuilder = buildProjectOnboardingDraft,
} = {}) {
  const bundle = normalizeBundle(input);
  const onboarding = await onboardingBuilder({
    projectId: bundle.project?.projectId,
    name: bundle.project?.name,
    rootDirectory: bundle.project?.rootDirectory,
    requesterIds: bundle.project?.requesterIds,
    profile: bundle.project?.profile,
  });
  let manifest = onboarding.manifest;
  const current = normalizedExistingProject(existingProject);
  if (current && !sameProjectIdentity(current, manifest)) {
    throw new Error("Existing project identity does not match the import bundle");
  }
  if (current) manifest = current;
  const projectAction = current ? "reuse" : "create";
  const sourceInspection = await inspectSources({
    rootDirectory: manifest.rootDirectory,
    sources: bundle.sources,
    realpathFn,
    lstatFn,
    readFileFn,
  });
  const candidates = [];
  const skipped = [];
  for (const [index, raw] of bundle.memories.entries()) {
    const candidate = normalizeCandidate(raw, index, {
      projectId: manifest.projectId,
      retentionDays: manifest.profile.memoryScope.retentionDays,
      sources: sourceInspection.byId,
    });
    if (!manifest.profile.memoryScope.allowedTypes.includes(candidate.type)) {
      candidate.skipReasons.push("outside_project_memory_scope");
    }
    if (candidate.skipReasons.length > 0) {
      skipped.push({ index, reasons: candidate.skipReasons });
      continue;
    }
    const comparable = comparableMemories(existingMemories, candidate, now);
    const duplicate = comparable.find(
      (memory) => memory.statement.trim() === candidate.statement,
    );
    const conflicts = comparable.filter(
      (memory) => memory.status === "confirmed" && memory.statement.trim() !== candidate.statement,
    );
    candidates.push({
      ...candidate,
      existing: {
        duplicateId: duplicate?.id ?? null,
        conflictIds: conflicts.map((memory) => memory.id),
      },
    });
  }
  const payload = previewDigestPayload({
    manifest,
    projectAction,
    sources: sourceInspection.inspected,
    candidates,
    skipped,
  });
  const digest = sha256(JSON.stringify(payload));
  return {
    ...payload,
    digest,
    confirmation: historicalProjectImportConfirmation(digest),
    checklist: onboarding.checklist,
    counts: {
      sources: sourceInspection.inspected.length,
      sourceBytes: sourceInspection.totalBytes,
      candidates: candidates.length,
      duplicates: candidates.filter((candidate) => candidate.existing.duplicateId).length,
      conflicts: candidates.filter((candidate) => candidate.existing.conflictIds.length > 0).length,
      skipped: skipped.length,
    },
    externalSystemsTouched: false,
    databaseWrite: false,
    memoriesConfirmed: 0,
  };
}

export function historicalMemoryProposals(preview, {
  now = new Date(),
  actor = "local-owner",
} = {}) {
  if (preview?.schema !== historicalProjectImportPreviewSchema) {
    throw new Error("Historical project import preview is invalid");
  }
  return preview.candidates
    .filter((candidate) => !candidate.existing.duplicateId)
    .map((candidate) => ({
      type: candidate.type,
      subject: candidate.subject,
      projectId: candidate.projectId,
      statement: candidate.statement,
      sourceType: "historical_project_import",
      sourceId: candidate.source.sha256,
      sourceVersion: candidate.source.sha256,
      scope: {
        factKey: candidate.factKey,
        sourcePath: candidate.source.path,
        sourceQuoteSha256: candidate.source.quoteSha256,
        importDigest: preview.digest,
      },
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      expiresAt: new Date(now.getTime() + candidate.retentionDays * 86_400_000),
      createdBy: actor,
    }));
}

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildHistoricalProjectImportPreview,
  historicalMemoryProposals,
  historicalProjectSourceSnapshot,
  historicalProjectImportSchema,
  loadHistoricalProjectSourceContents,
} from "./historical-project-import.mjs";

const maximumGeneratedBytes = 256 * 1024;
const maximumMemories = 100;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function memoryRule(project, now = new Date()) {
  const rule = project?.capabilities?.project_memory_proposal;
  if (!rule || rule.mode === "disabled") {
    throw new Error("Project memory automation is not authorized for this project");
  }
  if (rule.expiresAt && new Date(rule.expiresAt) <= now) {
    throw new Error("Project memory automation authorization has expired");
  }
  if (!Array.isArray(rule.sourcePaths) || rule.sourcePaths.length === 0) {
    throw new Error("Project memory automation requires fixed sourcePaths");
  }
  return rule;
}

function sourceDeclarations(paths) {
  return paths.map((path, index) => ({ id: `source_${index}`, path }));
}

function generatorPrompt(project, rule, sources) {
  return [
    "You are extracting durable project memory from an authorized Git repository.",
    `Project: ${project.projectId} (${project.name})`,
    `Objective: ${project.profile.objective}`,
    `Read only these project-relative files: ${sources.map((source) => `${source.id}=${source.path}`).join(", ")}`,
    `Allowed fact-key prefixes: ${rule.allowedFactKeyPrefixes.join(", ")}`,
    `Maximum retention days: ${rule.maxRetentionDays}`,
    "Return JSON with exactly one top-level key named memories.",
    `memories must be an array with at most ${maximumMemories} items.`,
    "Each item must contain type, statement, factKey, sourceId, sourceQuote, sensitivity, confidence, and retentionDays.",
    "type must be project or principle. sourceId must match the declared source_N identifier.",
    "sourceQuote must be a short exact quotation from that source file and must directly support statement.",
    "Only extract stable goals, constraints, decisions, operating principles, interfaces, or delivery rules that will matter in future work.",
    "Do not extract credentials, personal data, opinions about people, transient status, generated metrics, guesses, or facts without an exact quotation.",
    "Use confidence 1 only when the statement is directly and unambiguously supported; otherwise omit it.",
    "Add no markdown or commentary.",
  ].join("\n");
}

function parseGeneratedMemories(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Project memory generator did not return valid JSON");
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, "memories") ||
    !Array.isArray(parsed.memories) ||
    parsed.memories.length > maximumMemories
  ) {
    throw new Error("Project memory generator returned an invalid memory envelope");
  }
  return parsed.memories;
}

function generatedMemoryAllowed(memory, rule) {
  const factKey = String(memory?.factKey ?? "").trim();
  const retentionDays = Number(memory?.retentionDays);
  return rule.allowedFactKeyPrefixes.some((prefix) => factKey.startsWith(prefix)) &&
    Number.isSafeInteger(retentionDays) &&
    retentionDays >= 1 &&
    retentionDays <= rule.maxRetentionDays;
}

function assertGeneratedBundleAuthorization(bundle, rule) {
  const expectedSources = sourceDeclarations(rule.sourcePaths);
  const actualSources = Array.isArray(bundle?.sources) ? bundle.sources : [];
  const memories = Array.isArray(bundle?.memories) ? bundle.memories : [];
  if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
    throw new Error("Project memory sync sources no longer match the project authorization");
  }
  if (memories.some((memory) => !generatedMemoryAllowed(memory, rule))) {
    throw new Error("Project memory sync candidate exceeds the project authorization");
  }
}

function syncConfirmation(digest) {
  return `SYNC-${String(digest).slice(0, 12).toUpperCase()}`;
}

async function existingMemories(store, projectId) {
  if (!store?.listMemories) return [];
  const memories = await store.listMemories({ projectId, limit: 10_001 });
  if (memories.length > 10_000) {
    throw new Error("Project memory sync cannot safely bind more than 10000 memories");
  }
  return memories;
}

async function buildPreview({ project, bundle, store, now }) {
  const preview = await buildHistoricalProjectImportPreview(bundle, {
    existingProject: project,
    existingMemories: await existingMemories(store, project.projectId),
    now,
  });
  return {
    ...preview,
    syncSchema: "foursday-project-memory-sync-preview/v1",
    confirmation: syncConfirmation(preview.digest),
    modelInvoked: true,
    externalSystemsTouched: true,
    databaseWrite: false,
    memoriesConfirmed: 0,
  };
}

export async function previewProjectMemorySync({
  project,
  store = null,
  runtime,
  now = new Date(),
}) {
  if (!runtime?.generateArtifact) {
    throw new Error("Project memory sync requires a structured agent runtime");
  }
  const rule = memoryRule(project, now);
  const sources = sourceDeclarations(rule.sourcePaths);
  const sourceOnlyBundle = {
    schema: historicalProjectImportSchema,
    project: {
      projectId: project.projectId,
      name: project.name,
      rootDirectory: project.rootDirectory,
      requesterIds: project.requesters,
      profile: project.profile,
    },
    sources,
    memories: [],
  };
  const sourceOnlyPreview = await buildHistoricalProjectImportPreview(sourceOnlyBundle, {
    existingProject: project,
    existingMemories: [],
    now,
  });
  const sourceContents = await loadHistoricalProjectSourceContents({
    rootDirectory: project.rootDirectory,
    sources,
  });
  if (JSON.stringify(sourceContents.sources.map(({ content: _content, ...source }) => source)) !==
      JSON.stringify(sourceOnlyPreview.sources)) {
    throw new Error("Project memory sources changed before model isolation");
  }
  const isolatedWorkspace = await mkdtemp(join(tmpdir(), "foursday-memory-source-"));
  let generated;
  try {
    for (const source of sourceContents.sources) {
      const destination = join(isolatedWorkspace, source.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, source.content, { flag: "wx", mode: 0o600 });
    }
    generated = await runtime.generateArtifact({
      prompt: generatorPrompt(project, rule, sources),
      workingDirectory: isolatedWorkspace,
      outputDirectory: join(isolatedWorkspace, ".runtime"),
      timeoutMs: Math.min(Number(rule.timeoutMs ?? 120_000), 600_000),
      maxBytes: maximumGeneratedBytes,
    });
  } finally {
    await rm(isolatedWorkspace, { recursive: true, force: true });
  }
  const rawMemories = parseGeneratedMemories(generated.output);
  const rejectedByAuthorization = rawMemories.filter(
    (memory) => !generatedMemoryAllowed(memory, rule),
  ).length;
  const memories = rawMemories.filter((memory) => generatedMemoryAllowed(memory, rule));
  const bundle = {
    schema: historicalProjectImportSchema,
    project: {
      projectId: project.projectId,
      name: project.name,
      rootDirectory: project.rootDirectory,
      requesterIds: project.requesters,
      profile: project.profile,
    },
    sources,
    memories,
  };
  const preview = await buildPreview({ project, bundle, store, now });
  return {
    bundle,
    preview: {
      ...preview,
      generatedBy: generated.runtimeId ?? "structured-agent",
      generatedArtifactSha256: generated.sha256 ?? sha256(generated.output),
      rejectedByAuthorization,
      autoConfirmEligible: preview.candidates.filter((candidate) =>
        rule.mode === "automatic" &&
        rule.autoConfirm === true &&
        candidate.confidence === 1 &&
        candidate.sensitivity !== "confidential" &&
        candidate.existing.conflictIds.length === 0 &&
        !candidate.existing.duplicateId
      ).length,
      reviewRequired: preview.counts.conflicts + preview.counts.skipped +
        rejectedByAuthorization,
    },
  };
}

export async function applyProjectMemorySync({
  generated,
  project,
  store,
  capabilities = new Set(),
  confirmation = null,
  actor = "system:project-memory-sync",
  now = new Date(),
}) {
  if (!store?.proposeHistoricalProjectMemories || !store?.confirmMemory) {
    throw new Error("Project memory sync requires a writable memory store");
  }
  if (!(capabilities instanceof Set) || !capabilities.has("project_memory_proposal")) {
    throw new Error("Project memory sync is disabled by the global capability gate");
  }
  const rule = memoryRule(project, now);
  assertGeneratedBundleAuthorization(generated?.bundle, rule);
  const current = await buildPreview({
    project,
    bundle: generated.bundle,
    store,
    now,
  });
  if (current.digest !== generated.preview.digest) {
    throw new Error("Project sources or memory state changed after sync preview");
  }
  if (rule.mode !== "automatic" && confirmation !== syncConfirmation(current.digest)) {
    throw new Error("Project memory sync requires the current preview confirmation");
  }
  const proposals = historicalMemoryProposals(current, { now, actor });
  const results = proposals.length > 0
    ? await store.proposeHistoricalProjectMemories(proposals, now)
    : [];
  const latestSources = await historicalProjectSourceSnapshot({
    rootDirectory: project.rootDirectory,
    sources: current.sources.map((source) => ({ id: source.id, path: source.path })),
  });
  const sourcesStable = JSON.stringify(latestSources.sources) === JSON.stringify(current.sources);
  let confirmed = 0;
  let reviewRequired = current.counts.skipped +
    Number(generated.preview.rejectedByAuthorization ?? 0);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const proposal = proposals[index];
    const candidate = current.candidates.find((item) =>
      item.factKey === proposal.scope.factKey &&
      item.statement === proposal.statement &&
      item.source.sha256 === proposal.sourceId
    );
    const eligible = result.created &&
      rule.mode === "automatic" &&
      rule.autoConfirm === true &&
      sourcesStable &&
      candidate?.confidence === 1 &&
      candidate.sensitivity !== "confidential" &&
      candidate.existing.conflictIds.length === 0;
    if (!eligible) {
      if (result.created) reviewRequired += 1;
      continue;
    }
    try {
      await store.confirmMemory(result.id, actor, now);
      confirmed += 1;
    } catch {
      reviewRequired += 1;
    }
  }
  return {
    schema: "foursday-project-memory-sync-result/v1",
    projectId: project.projectId,
    sourceFiles: current.counts.sources,
    candidatesCreated: results.filter((result) => result.created).length,
    duplicatesSkipped: current.counts.duplicates +
      results.filter((result) => result.reason === "duplicate").length,
    memoriesConfirmed: confirmed,
    reviewRequired,
    sourcesStable,
    databaseWrite: results.some((result) => result.created),
    externalSystemsTouched: true,
  };
}

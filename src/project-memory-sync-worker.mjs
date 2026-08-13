import { setTimeout as delay } from "node:timers/promises";
import { historicalProjectSourceSnapshot } from "./historical-project-import.mjs";
import {
  applyProjectMemorySync,
  previewProjectMemorySync,
} from "./project-memory-sync.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import { safeErrorCode } from "./logging.mjs";

function checkpointKey(projectId) {
  return `project-memory-sync:${projectId}:source-digest`;
}

function statusCheckpointKey(projectId) {
  return `project-memory-sync:${projectId}:status`;
}

function parsedStatus(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function recordStatus(store, projectId, value, now) {
  await store.setCheckpoint(statusCheckpointKey(projectId), JSON.stringify(value), now);
}

export async function syncAutomaticProjectMemoriesOnce({
  store,
  projectsDirectory,
  runtimeFactory,
  capabilities = new Set(),
  now = new Date(),
  manifestLoader = loadProjectManifests,
}) {
  if (!store?.getCheckpoint || !store?.setCheckpoint) {
    throw new Error("Automatic project memory sync requires checkpoint storage");
  }
  const summary = {
    globallyEnabled: capabilities instanceof Set &&
      capabilities.has("project_memory_proposal"),
    projectsInspected: 0,
    automaticProjects: 0,
    unchangedProjects: 0,
    syncedProjects: 0,
    candidatesCreated: 0,
    memoriesConfirmed: 0,
    reviewRequired: 0,
    failures: [],
  };
  if (!summary.globallyEnabled) return summary;
  const projects = await manifestLoader(projectsDirectory);
  summary.projectsInspected = projects.size;
  for (const project of projects.values()) {
    const rule = project.capabilities?.project_memory_proposal;
    if (rule?.mode !== "automatic" || !Array.isArray(rule.sourcePaths) || rule.sourcePaths.length === 0) {
      continue;
    }
    summary.automaticProjects += 1;
    try {
      const sources = rule.sourcePaths.map((path, index) => ({ id: `source_${index}`, path }));
      const sourceSnapshot = await historicalProjectSourceSnapshot({
        rootDirectory: project.rootDirectory,
        sources,
      });
      const key = checkpointKey(project.projectId);
      if (await store.getCheckpoint(key) === sourceSnapshot.digest) {
        summary.unchangedProjects += 1;
        const previous = parsedStatus(
          await store.getCheckpoint(statusCheckpointKey(project.projectId)),
        );
        await recordStatus(store, project.projectId, {
          state: "unchanged",
          lastCheckedAt: now.toISOString(),
          lastSuccessAt: previous.lastSuccessAt ?? null,
          sourceDigest: sourceSnapshot.digest,
          candidatesCreated: 0,
          memoriesConfirmed: 0,
          reviewRequired: Number(previous.reviewRequired ?? 0),
          errorCode: null,
        }, now);
        continue;
      }
      const runtime = await runtimeFactory(project);
      const generated = await previewProjectMemorySync({ project, store, runtime, now });
      const result = await applyProjectMemorySync({
        generated,
        project,
        store,
        capabilities,
        now,
      });
      await store.setCheckpoint(key, sourceSnapshot.digest);
      await recordStatus(store, project.projectId, {
        state: result.reviewRequired > 0 ? "review_required" : "synchronized",
        lastCheckedAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        sourceDigest: sourceSnapshot.digest,
        candidatesCreated: result.candidatesCreated,
        memoriesConfirmed: result.memoriesConfirmed,
        reviewRequired: result.reviewRequired,
        errorCode: null,
      }, now);
      summary.syncedProjects += 1;
      summary.candidatesCreated += result.candidatesCreated;
      summary.memoriesConfirmed += result.memoriesConfirmed;
      summary.reviewRequired += result.reviewRequired;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      summary.failures.push({
        projectId: project.projectId,
        errorCode,
      });
      await recordStatus(store, project.projectId, {
        state: "failed",
        lastCheckedAt: now.toISOString(),
        lastSuccessAt: parsedStatus(
          await store.getCheckpoint(statusCheckpointKey(project.projectId)),
        ).lastSuccessAt ?? null,
        sourceDigest: null,
        candidatesCreated: 0,
        memoriesConfirmed: 0,
        reviewRequired: 0,
        errorCode,
      }, now).catch(() => {});
    }
  }
  return summary;
}

export async function runProjectMemorySyncWorker({
  store,
  projectsDirectory,
  runtimeFactory,
  capabilities = new Set(),
  intervalMs = 60 * 60 * 1_000,
  signal = null,
  log = () => {},
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 86_400_000) {
    throw new Error("Project memory sync interval must be between 1 minute and 24 hours");
  }
  while (!signal?.aborted) {
    const summary = await syncAutomaticProjectMemoriesOnce({
      store,
      projectsDirectory,
      runtimeFactory,
      capabilities,
    });
    log("project_memory_sync.completed", summary);
    try {
      await delay(intervalMs, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
}

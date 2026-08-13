import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildHistoricalProjectImportPreview,
  historicalMemoryProposals,
} from "./historical-project-import.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";

export async function previewHistoricalProjectImport({
  bundle,
  projectsDirectory,
  store = null,
  now = new Date(),
  manifestLoader = loadProjectManifests,
  previewBuilder = buildHistoricalProjectImportPreview,
}) {
  const projects = await manifestLoader(projectsDirectory);
  const projectId = String(bundle?.project?.projectId ?? "").trim();
  const existingProject = projects.get(projectId) ?? null;
  const existingMemories = store?.listMemories
    ? await store.listMemories({ projectId, limit: 10_001 })
    : [];
  if (existingMemories.length > 10_000) {
    throw new Error("Historical project import cannot safely bind more than 10000 memories");
  }
  const preview = await previewBuilder(bundle, {
    existingProject,
    existingMemories,
    now,
  });
  return {
    ...preview,
    existingStateChecked: Boolean(store?.listMemories),
  };
}

export async function applyHistoricalProjectImport({
  bundle,
  projectsDirectory,
  store,
  confirmation,
  actor,
  now = new Date(),
  manifestLoader = loadProjectManifests,
  previewBuilder = buildHistoricalProjectImportPreview,
}) {
  if (!store?.proposeHistoricalProjectMemories) {
    throw new Error("Historical project import requires a writable memory store");
  }
  const preview = await previewHistoricalProjectImport({
    bundle,
    projectsDirectory,
    store,
    now,
    manifestLoader,
    previewBuilder,
  });
  if (confirmation !== preview.confirmation) {
    throw new Error("Historical project import confirmation does not match the current preview");
  }
  await mkdir(projectsDirectory, { recursive: true, mode: 0o700 });
  let manifestCreated = false;
  const destination = join(projectsDirectory, `${preview.manifest.projectId}.json`);
  if (preview.projectAction === "create") {
    await writeFile(destination, `${JSON.stringify(preview.manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(destination, 0o600);
    manifestCreated = true;
  }
  try {
    const proposals = historicalMemoryProposals(preview, { now, actor });
    const results = proposals.length > 0
      ? await store.proposeHistoricalProjectMemories(proposals, now)
      : [];
    return {
      schema: "foursday-historical-project-import-result/v1",
      projectId: preview.manifest.projectId,
      projectAction: preview.projectAction,
      manifestCreated,
      importDigest: preview.digest,
      candidatesCreated: results.filter((result) => result.created).length,
      duplicatesSkipped: preview.counts.duplicates +
        results.filter((result) => result.reason === "duplicate").length,
      existingImportRecords: results.filter(
        (result) => result.reason === "existing_import_record",
      ).length,
      conflictsPendingReview: results.reduce(
        (total, result) => total + Number(result.conflictCount ?? 0),
        0,
      ),
      invalidCandidatesSkipped: preview.counts.skipped,
      memoryIds: results.filter((result) => result.created).map((result) => result.id),
      memoriesConfirmed: 0,
      externalSystemsTouched: false,
      databaseWrite: results.some((result) => result.created),
      nextAction: "Review every proposed memory and explicitly confirm or revoke it.",
    };
  } catch (error) {
    if (manifestCreated) await unlink(destination).catch(() => {});
    throw error;
  }
}

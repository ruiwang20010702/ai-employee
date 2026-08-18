import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { safeErrorCode } from "../src/logging.mjs";
import { reconcileMemorySources } from "../src/memory-source-access.mjs";
import { synchronizeMemoryAuthority } from "../src/memory-authority.mjs";
import { reconcileMemoryAuthorityCleanup } from "../src/memory-authority-cleanup.mjs";
import { createStructuredArtifactRuntime } from "../src/artifact-runtime.mjs";
import { syncAutomaticProjectMemoriesOnce } from "../src/project-memory-sync-worker.mjs";
import { loadProjectManifests } from "../src/project-manifests.mjs";
import { createProductionStore } from "../src/production-store.mjs";

await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);
try {
  const projectMemory = await syncAutomaticProjectMemoriesOnce({
    store,
    projectsDirectory: config.projectsDirectory,
    runtimeFactory: async () => createStructuredArtifactRuntime({
      runtime: config.agentRuntime,
      codexPath: config.codexPath,
      claudeCodePath: config.claudeCodePath,
    }),
    capabilities: config.capabilities,
  });
  const authority = config.memoryAuthorityMode === "gbrain" &&
      config.memoryAuthorityWrite
    ? await synchronizeMemoryAuthority({
        store,
        gbrainPath: config.gbrainPath,
        autoConfirm: config.memoryAuthorityAutoConfirm,
        autoConfirmMinimumConfidence:
          config.memoryAuthorityAutoConfirmMinimumConfidence,
        leaseMs: config.memorySourceLeaseMs,
        limit: Math.min(config.memorySourceLimit, 500),
        maxProjectFacts: config.memoryAuthorityMaxProjectFacts,
        authorityRoot: config.memoryAuthorityRoot,
        authoritySourceId: config.memoryAuthoritySourceId,
        gbrainHome: config.gbrainHome,
        gbrainDatabaseUrl: config.gbrainDatabaseUrl,
      })
    : {
        inspected: 0,
        eligible: 0,
        promoted: 0,
        confirmed: 0,
        failed: 0,
        failures: [],
        writeEnabled: false,
      };
  const cleanup = config.memoryAuthorityMode === "gbrain" &&
      config.memoryAuthorityRoot
    ? await reconcileMemoryAuthorityCleanup({
        store,
        gbrainPath: config.gbrainPath,
        authorityRoot: config.memoryAuthorityRoot,
        authoritySourceId: config.memoryAuthoritySourceId,
        gbrainHome: config.gbrainHome,
        gbrainDatabaseUrl: config.gbrainDatabaseUrl,
        limit: Math.min(config.memorySourceLimit, 500),
      })
    : {
        claimed: 0,
        completed: 0,
        failed: 0,
        failures: [],
        writeEnabled: false,
      };
  const sources = config.personalMemoryEnabled
    ? {
        inspected: 0,
        valid: 0,
        unavailable: 0,
        revoked: 0,
        skipped: "personal_gbrain_read_through",
      }
    : await reconcileMemorySources({
        store,
        projects: await loadProjectManifests(config.projectsDirectory),
        gbrainPath: config.gbrainPath,
        leaseMs: config.memorySourceLeaseMs,
        limit: config.memorySourceLimit,
        gbrainHome: config.gbrainHome,
        gbrainDatabaseUrl: config.gbrainDatabaseUrl,
      });
  const report = { projectMemory, authority, cleanup, sources };
  await store.setCheckpoint("memory-source:last-report", JSON.stringify(report));
  if (
    projectMemory.failures.length > 0 ||
    authority.failed > 0 ||
    cleanup.failed > 0 ||
    sources.unavailable > 0
  ) {
    const error = new Error("One or more memory sources are unavailable");
    error.code = "MEMORY_SOURCE_UNAVAILABLE";
    throw error;
  }
  await store.setCheckpoint(
    "memory-source:last-success",
    JSON.stringify(report),
  );
  console.log(JSON.stringify({ completed: true, ...report }));
} catch (error) {
  const errorCode = safeErrorCode(error);
  await store.setCheckpoint("memory-source:last-failure", errorCode).catch(() => {});
  console.error(JSON.stringify({ completed: false, errorCode }));
  process.exitCode = 1;
} finally {
  await store.close();
}

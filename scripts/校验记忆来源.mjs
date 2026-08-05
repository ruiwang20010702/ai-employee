import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { safeErrorCode } from "../src/logging.mjs";
import { reconcileMemorySources } from "../src/memory-source-access.mjs";
import { loadProjectManifests } from "../src/project-manifests.mjs";
import { createProductionStore } from "../src/production-store.mjs";

await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);
try {
  const report = await reconcileMemorySources({
    store,
    projects: await loadProjectManifests(config.projectsDirectory),
    gbrainPath: config.gbrainPath,
    leaseMs: config.memorySourceLeaseMs,
    limit: config.memorySourceLimit,
  });
  await store.setCheckpoint("memory-source:last-report", JSON.stringify(report));
  if (report.unavailable > 0) {
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

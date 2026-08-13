import { createStructuredArtifactRuntime } from "../src/artifact-runtime.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  runProjectMemorySyncWorker,
  syncAutomaticProjectMemoriesOnce,
} from "../src/project-memory-sync-worker.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { createProductionStore } from "../src/production-store.mjs";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const intervalMinutes = Number(value("--interval-minutes") ?? 60);
if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1_440) {
  throw new Error("--interval-minutes must be an integer between 1 and 1440");
}
if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);
const runtimeFactory = async () => createStructuredArtifactRuntime({
  runtime: config.agentRuntime,
  codexPath: config.codexPath,
  claudeCodePath: config.claudeCodePath,
});
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}
try {
  if (!watch) {
    console.log(JSON.stringify(await syncAutomaticProjectMemoriesOnce({
      store,
      projectsDirectory: config.projectsDirectory,
      runtimeFactory,
      capabilities: config.capabilities,
    }), null, 2));
  } else {
    await runProjectMemorySyncWorker({
      store,
      projectsDirectory: config.projectsDirectory,
      runtimeFactory,
      capabilities: config.capabilities,
      intervalMs: intervalMinutes * 60_000,
      signal: controller.signal,
      log(type, details) {
        console.log(JSON.stringify({ type, at: new Date().toISOString(), ...details }));
      },
    });
  }
} finally {
  await store.close();
}

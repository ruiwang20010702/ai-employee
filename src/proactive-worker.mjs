import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.mjs";
import { createProductionStore } from "./production-store.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import { loadWorkRecipes } from "./recipe-library.mjs";
import { runDueProactiveTrigger } from "./proactive-runtime.mjs";
import { safeErrorCode } from "./logging.mjs";
import { isMainModule } from "./main-module.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

export async function runProactiveWorker({
  config = loadConfig({ requireTargets: false, production: true }),
  store = null,
  owner = `proactive:${process.pid}`,
  once = false,
} = {}) {
  store = store ?? await createProductionStore(config);
  let stopped = false;
  const stopController = new AbortController();
  const tick = async () => {
    await store.recordHeartbeat?.("proactive");
    if (!config.capabilities.has("proactive_work") || await store.isPaused()) return false;
    const result = await runDueProactiveTrigger({
      store,
      tenantId: config.tenantId,
      manifests: await loadProjectManifests(config.projectsDirectory),
      recipes: await loadWorkRecipes(config.recipesDirectory),
      owner,
    });
    if (result?.created) log("proactive.plan_created", { triggerId: result.triggerId, planId: result.plan.id });
    return Boolean(result);
  };
  if (once) {
    try {
      await tick();
    } finally {
      await store.close();
    }
    return { stop() {} };
  }
  const loop = (async () => {
    while (!stopped) {
      try { await tick(); } catch (error) {
        log("proactive.error", { errorCode: safeErrorCode(error) });
      }
      if (!stopped) {
        try {
          await delay(config.proactivePollMs, undefined, { signal: stopController.signal });
        } catch (error) {
          if (error.name !== "AbortError") throw error;
        }
      }
    }
  })();
  return { async stop() { stopped = true;stopController.abort();await loop;await store.close(); } };
}

if (isMainModule(import.meta.url)) {
  const worker = await runProactiveWorker({ once: process.argv.includes("--once") });
  if (!process.argv.includes("--once")) {
    const shutdown = async () => {
      await worker.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

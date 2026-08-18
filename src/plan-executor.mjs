import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.mjs";
import { safeErrorCode } from "./logging.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import { createProductionStore } from "./production-store.mjs";
import { createControlledWorkAdapters } from "./work-adapters.mjs";
import { executeWorkPlan } from "./work-executor.mjs";
import { planResultTaskId } from "./plan-result-notification.mjs";
import { isMainModule } from "./main-module.mjs";
import { pausedPlanScopes } from "./scoped-pause.mjs";
import { loadWorkRecipes } from "./recipe-library.mjs";
import { captureWorkPlanGraph } from "./governed-work-graph-runtime.mjs";
import { createPersonalMemoryClient } from "./personal-memory-client.mjs";

function log(type, fields = {}) {
  console.log(JSON.stringify({ type, at: new Date().toISOString(), ...fields }));
}

function domainObservationTime(record, fallback = new Date()) {
  const candidate = record?.updated_at ?? record?.updatedAt ?? fallback;
  const value = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(value.getTime())) {
    throw new Error("Graph replay requires a valid domain update timestamp");
  }
  return value;
}

export async function reconcileGovernedWorkGraphs({
  store,
  config,
  limit = 100,
} = {}) {
  if (!store?.appendGraphProjection) return { changed: 0, failed: 0 };
  const projects = await loadProjectManifests(config.projectsDirectory);
  const recipes = await loadWorkRecipes(config.recipesDirectory);
  let changed = 0;
  let failed = 0;
  for (const status of ["completed", "failed", "cancelled"]) {
    const plans = await store.listWorkPlans({ status, limit });
    for (const plan of plans) {
      const manifest = projects.get(plan.project_id);
      const recipe = plan.plan?.recipe?.id
        ? recipes.get(plan.plan.recipe.id) ?? null
        : null;
      try {
        if (!manifest) throw new Error("project_manifest_unavailable");
        if (plan.plan?.recipe?.id && !recipe) {
          throw new Error("work_recipe_unavailable");
        }
        const result = await captureWorkPlanGraph({
          store,
          tenantId: config.tenantId,
          manifest,
          workPlan: plan,
          recipe,
          observedAt: domainObservationTime(plan),
        });
        if ((result.insertedNodes ?? 0) + (result.insertedEdges ?? 0) > 0) {
          changed += 1;
        }
      } catch (error) {
        failed += 1;
        await store.setCheckpoint?.(
          `executor:graph-replay:${plan.id}`,
          safeErrorCode(error),
        );
        log("executor.graph_replay_failed", {
          planId: plan.id,
          errorCode: safeErrorCode(error),
        });
      }
    }
  }
  return { changed, failed };
}

export async function processNextWorkPlan({
  store,
  config,
  adapters,
  executionOwner,
  now = () => new Date(),
}) {
  if (!config.capabilities.has("work_plan_execution")) return false;
  const projects = await loadProjectManifests(config.projectsDirectory);
  const [approved, automatic] = await Promise.all([
    store.listWorkPlans({ status: "approved", limit: 100 }),
    store.listWorkPlans({ status: "ready", limit: 100 }),
  ]);
  const candidates = [...approved, ...automatic].sort(
    (left, right) =>
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );
  let plan = null;
  for (const candidate of candidates) {
    if ((await pausedPlanScopes(store, candidate.plan)).length === 0) {
      plan = candidate;
      break;
    }
  }
  if (!plan) return false;
  const manifest = projects.get(plan.project_id);
  if (!manifest) {
    await store.setCheckpoint?.(
      "executor:last-failure",
      "project_manifest_unavailable",
    );
    log("executor.plan_blocked", {
      planId: plan.id,
      errorCode: "project_manifest_unavailable",
    });
    return false;
  }
  const recipe = plan.plan?.recipe?.id
    ? (await loadWorkRecipes(config.recipesDirectory)).get(plan.plan.recipe.id) ?? null
    : null;
  await captureWorkPlanGraph({
    store,
    tenantId: config.tenantId,
    manifest,
    workPlan: plan,
    recipe,
    observedAt: domainObservationTime(plan, now()),
  });
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    adapters,
    executionOwner,
    leaseMs: config.planExecutionLeaseMs,
    leaseRenewMs: config.planExecutionLeaseRenewMs,
    manifestProvider: async (projectId) =>
      (await loadProjectManifests(config.projectsDirectory)).get(projectId) ?? null,
    now,
  });
  const completedPlan = await store.getWorkPlan(plan.id);
  try {
    await captureWorkPlanGraph({
      store,
      tenantId: config.tenantId,
      manifest,
      workPlan: completedPlan,
      recipe,
      observedAt: domainObservationTime(completedPlan, now()),
    });
  } catch (error) {
    await store.setCheckpoint?.("executor:last-graph-failure", safeErrorCode(error));
    log("executor.graph_capture_failed", {
      planId: plan.id,
      errorCode: safeErrorCode(error),
    });
  }
  const notification = await store.ensureWorkPlanResultDraft?.(plan.id, now());
  await store.setCheckpoint?.("executor:last-success", now().toISOString());
  log("executor.plan_finished", {
    planId: plan.id,
    projectId: plan.project_id,
    status: result.status,
    failedStep: result.failedStep,
    errorCode: result.errorCode,
    notificationTaskId: notification?.id,
  });
  return true;
}

export async function reconcilePlanResultDrafts({
  store,
  limit = 100,
  now = new Date(),
}) {
  let created = 0;
  for (const status of ["completed", "failed", "cancelled"]) {
    const plans = await store.listWorkPlans({ status, limit });
    for (const plan of plans) {
      if (!plan.plan?.sourceTaskId) continue;
      const before = await store.getTask?.(planResultTaskId(plan.id));
      const task = await store.ensureWorkPlanResultDraft?.(plan.id, now);
      if (!before && task) created += 1;
    }
  }
  return created;
}

export async function runPlanExecutor({
  config = loadConfig({ requireTargets: false, production: true }),
  store = null,
  adapters = null,
  personalMemoryClient = undefined,
  once = process.argv.includes("--once"),
  executionOwner = `${hostname()}:${process.pid}:${randomUUID()}`,
} = {}) {
  store = store ? await store.open() : await createProductionStore(config);
  if (personalMemoryClient === undefined) {
    personalMemoryClient = createPersonalMemoryClient(config);
  }
  adapters = adapters ?? createControlledWorkAdapters({
    codexPath: config.codexPath,
    personalMemoryClient,
    dwsPath: config.dwsPath,
    gbrainPath: config.gbrainPath,
    gbrainSourceId: config.memoryAuthoritySourceId,
    gbrainHome: config.gbrainHome,
    gbrainDatabaseUrl: config.gbrainDatabaseUrl,
    ghPath: config.ghPath,
    store,
  });
  let stopped = false;
  let heartbeatTimer;
  const stopController = new AbortController();
  const interruptibleDelay = async () => {
    try {
      await delay(config.planExecutorPollMs, undefined, {
        signal: stopController.signal,
      });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  };
  const tick = async () => {
    await store.recordHeartbeat?.("executor");
    const recovered = await store.recoverExpiredWorkPlans?.(new Date()) ?? 0;
    if (recovered > 0) {
      log("executor.interrupted_plans_failed", { count: recovered });
    }
    const graphReplay = await reconcileGovernedWorkGraphs({ store, config });
    if (await store.isPaused()) return graphReplay.changed > 0;
    const notifications = await reconcilePlanResultDrafts({ store });
    const executed = await processNextWorkPlan({
      store,
      config,
      adapters,
      executionOwner,
    });
    return graphReplay.changed > 0 || notifications > 0 || executed;
  };

  if (once) {
    while (await tick()) {
      // Drain only currently authorized plans.
    }
    await store.close();
    return { stop() {} };
  }

  log("executor.started", {
    enabled: config.capabilities.has("work_plan_execution"),
  });
  heartbeatTimer = setInterval(() => {
    if (stopped) return;
    store.recordHeartbeat?.("executor")?.catch((error) => {
      log("executor.heartbeat_error", { errorCode: safeErrorCode(error) });
    });
  }, config.heartbeatMs);
  const loop = (async () => {
    while (!stopped) {
      try {
        const worked = await tick();
        if (!worked) await interruptibleDelay();
      } catch (error) {
        const errorCode = safeErrorCode(error);
        await (store.setCheckpoint?.("executor:last-failure", errorCode) ?? Promise.resolve())
          .catch(() => {});
        log("executor.error", { errorCode });
        if (!stopped) await interruptibleDelay();
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      stopController.abort();
      await loop;
      await store.close();
      log("executor.stopped");
    },
  };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const executor = await runPlanExecutor();
  const shutdown = async () => {
    await executor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

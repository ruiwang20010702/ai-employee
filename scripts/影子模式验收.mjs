import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { evaluateHealth } from "../src/health-check.mjs";
import { createProductionStore } from "../src/production-store.mjs";
import {
  evaluateDecisionQuality,
  evaluateDecisionReviewCoverage,
} from "../src/decision-quality.mjs";

await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const forbidden = [
  "send_message",
  "send_group_message",
  "work_plan_execution",
].filter((capability) =>
  config.capabilities.has(capability),
);
if (forbidden.length > 0) {
  throw new Error("Shadow acceptance requires sending and work plan execution to be disabled");
}

let store;
try {
  store = await createProductionStore(config, { readOnly: true });
  const [health, tasks, plans, memories, reviews] = await Promise.all([
    evaluateHealth({ store, config }),
    store.listTasks({ limit: 500 }),
    store.listWorkPlans({ limit: 100 }),
    store.listMemories({ limit: 100 }),
    store.listDecisionReviews({ limit: 10_000 }),
  ]);
  const quality = evaluateDecisionQuality(reviews, {
    minimumSamples: config.shadowMinimumSamples,
    minimumNoReplyAccuracy: config.shadowMinimumNoReplyAccuracy,
  });
  quality.coverage = evaluateDecisionReviewCoverage(tasks, reviews, {
    targetGroupIds: config.targetGroupIds,
    minimumSamples: config.shadowMinimumSamples,
  });
  quality.gates.coverage = quality.coverage.accepted;
  quality.accepted = Object.values(quality.gates).every(Boolean);
  const blockingTaskStatuses = new Set(["dead", "send_unknown"]);
  const blockingPlanStatuses = new Set(["executing", "verifying"]);
  const blockers = {
    unhealthy: !health.ready,
    abnormalTasks: tasks.filter((task) => blockingTaskStatuses.has(task.status)).length,
    activePlans: plans.filter((plan) => blockingPlanStatuses.has(plan.status)).length,
  };
  const accepted =
    !blockers.unhealthy &&
    blockers.abnormalTasks === 0 &&
    blockers.activePlans === 0 &&
    quality.accepted;
  console.log(
    JSON.stringify({
      accepted,
      mode: "shadow",
      sendCapabilitiesEnabled: false,
      healthReady: health.ready,
      reviewed: {
        recentTasks: tasks.length,
        recentPlans: plans.length,
        recentMemories: memories.length,
      },
      blockers,
      quality,
    }),
  );
  if (!accepted) process.exitCode = 1;
} catch (error) {
  if (!String(error.code ?? "").startsWith("database_")) throw error;
  console.error(JSON.stringify({
    accepted: false,
    mode: "shadow",
    databaseWrite: false,
    errorCode: error.code,
    migrations: error.migrations ?? [],
    action: error.code === "database_migration_checksum_mismatch"
      ? "停止发布且不要执行迁移；先恢复正确的迁移文件。"
      : "先完成带备份的受控迁移，再执行影子验收。",
  }));
  process.exitCode = 1;
} finally {
  await store?.close();
}

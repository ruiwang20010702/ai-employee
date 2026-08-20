#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import {
  assertServiceRollbackState,
  inspectServiceRollbackState,
} from "../src/rollback-state-guard.mjs";
import { isMainModule } from "../src/main-module.mjs";

export async function previousReleaseSupportsContinuation(previousRelease) {
  return previousReleaseIncludesMigration(
    previousRelease,
    "017_等待信息任务链.sql",
  );
}

export async function previousReleaseSupportsCapabilityBudget(previousRelease) {
  return previousReleaseIncludesMigration(
    previousRelease,
    "018_能力次数预算.sql",
  );
}

export async function previousReleaseSupportsHermesMemoryCandidates(previousRelease) {
  return previousReleaseIncludesMigration(
    previousRelease,
    "024_Hermes个人记忆候选.sql",
  );
}

async function previousReleaseIncludesMigration(previousRelease, filename) {
  if (!previousRelease) return false;
  const migration = join(
    resolve(previousRelease),
    "db",
    "migrations",
    filename,
  );
  return access(migration).then(() => true).catch(() => false);
}

export async function verifyServiceRollbackState({
  config,
  pool,
  previousRelease = "",
} = {}) {
  if (!config) {
    await applyProductionConfigFile();
    config = loadConfig({ requireTargets: false, production: true });
  }
  const ownedPool = pool == null;
  pool = pool ?? createPostgresPool(config);
  try {
    const [
      targetSupportsContinuation,
      targetSupportsCapabilityBudget,
      targetSupportsHermesMemoryCandidates,
    ] = await Promise.all([
      previousReleaseSupportsContinuation(previousRelease),
      previousReleaseSupportsCapabilityBudget(previousRelease),
      previousReleaseSupportsHermesMemoryCandidates(previousRelease),
    ]);
    return assertServiceRollbackState(await inspectServiceRollbackState(pool, {
      targetSupportsContinuation,
      targetSupportsCapabilityBudget,
      targetSupportsHermesMemoryCandidates,
    }));
  } finally {
    if (ownedPool) await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const previousIndex = process.argv.indexOf("--previous");
    if (previousIndex >= 0 && !process.argv[previousIndex + 1]) {
      throw new Error("--previous 缺少目录参数");
    }
    const unknown = process.argv.slice(2).filter(
      (value, index, args) =>
        value !== "--previous" && args[index - 1] !== "--previous",
    );
    if (unknown.length > 0) throw new Error(`未知参数：${unknown[0]}`);
    console.log(JSON.stringify(await verifyServiceRollbackState({
      previousRelease: previousIndex >= 0
        ? process.argv[previousIndex + 1]
        : "",
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      compatible: false,
      errorCode: error.code ?? "service_rollback_guard_failed",
      activeContinuationTasks: error.count ?? null,
      hermesMemoryCandidateRows: error.code === "service_rollback_hermes_memory_candidates_present"
        ? error.count ?? null
        : null,
    }, null, 2));
    process.exitCode = 1;
  }
}

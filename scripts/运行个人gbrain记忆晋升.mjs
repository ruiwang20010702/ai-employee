#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.mjs";
import { PersonalGbrainCandidateStore } from "../src/personal-gbrain-candidate-store.mjs";
import {
  promoteOnePersonalGbrainCandidate,
  reconcilePromotedPersonalGbrainCandidates,
  retireOnePersonalGbrainCandidate,
} from "../src/personal-gbrain-promoter.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

const args = process.argv.slice(2);
if (args.some((argument) => !["--once", "--quiet-idle"].includes(argument))) {
  throw new Error("Usage: 运行个人gbrain记忆晋升.mjs [--once] [--quiet-idle]");
}
if (!process.env.FOURSDAY_CONFIG_FILE && process.env.FOURSDAY_PRODUCTION_CONFIG) {
  process.env.FOURSDAY_CONFIG_FILE = process.env.FOURSDAY_PRODUCTION_CONFIG;
}
await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
if (!config.personalMemoryWriteEnabled) {
  if (!args.includes("--quiet-idle")) {
    console.log(JSON.stringify({
      enabled: false,
      processed: 0,
      reason: "personal_memory_write_disabled",
    }));
  }
  process.exit(0);
}
const pool = createPostgresPool(config);
try {
  const store = await new PersonalGbrainCandidateStore({
    pool,
    tenantId: config.tenantId,
    dataKey: config.dataKey,
  }).open();
  const owner = `promoter:${process.pid}:${randomUUID()}`;
  const retirement = await retireOnePersonalGbrainCandidate({
    store,
    config,
    owner,
  });
  const promotion = await promoteOnePersonalGbrainCandidate({
    store,
    config,
    registryPath: process.env.FOURSDAY_PROJECT_REGISTRY,
    owner,
  });
  const reconciliation = await reconcilePromotedPersonalGbrainCandidates({
    store,
    config,
    registryPath: process.env.FOURSDAY_PROJECT_REGISTRY,
  });
  const result = { retirement, promotion, reconciliation };
  const idle = retirement.processed === 0 && promotion.processed === 0 && reconciliation.revoked === 0 &&
    reconciliation.failed === 0;
  if (!args.includes("--quiet-idle") || !idle) console.log(JSON.stringify(result));
  if (
    retirement.status === "retirement_pending" ||
    promotion.status === "blocked" ||
    reconciliation.failed > 0
  ) process.exitCode = 1;
} finally {
  await pool.end();
}

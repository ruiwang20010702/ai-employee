import { loadConfig } from "./config.mjs";
import { evaluateFoursdayHealth } from "./foursday-runtime-status.mjs";
import { createProductionStore } from "./production-store.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";

if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}
const config = loadConfig({ requireTargets: false, production: true });
const store = await createProductionStore(config);

try {
  const health = await evaluateFoursdayHealth({ store, config });
  console.log(
    JSON.stringify(
      { healthy: health.ready, checks: health.checks },
      null,
      2,
    ),
  );
  if (!health.ready) process.exitCode = 1;
} finally {
  await store.close();
}

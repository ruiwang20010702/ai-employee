import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { DwsAdapter } from "../src/dws.mjs";
import { safeErrorCode } from "../src/logging.mjs";
import { reconcileMessageCoverage } from "../src/message-reconciliation.mjs";
import { createProductionStore } from "../src/production-store.mjs";

await applyProductionConfigFile();
const config = loadConfig({ production: true });
const store = await createProductionStore(config);
try {
  const report = await reconcileMessageCoverage({
    config,
    store,
    dws: new DwsAdapter(config),
  });
  console.log(JSON.stringify({ completed: true, ...report }));
} catch (error) {
  console.error(JSON.stringify({
    completed: false,
    errorCode: safeErrorCode(error),
  }));
  process.exitCode = 1;
} finally {
  await store.close();
}

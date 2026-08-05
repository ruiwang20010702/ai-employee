import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { checkProductionReadiness } from "../src/production-readiness.mjs";

await applyProductionConfigFile();
const config = loadConfig({ production: true });
const readiness = await checkProductionReadiness({ config });
console.log(
  JSON.stringify(
    {
      ...readiness,
      databaseWrite: false,
      note: "Preflight passed without migration; run db:migrate explicitly before service installation.",
    },
    null,
    2,
  ),
);

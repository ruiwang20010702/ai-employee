import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { checkProductionReadiness } from "../src/production-readiness.mjs";

await applyProductionConfigFile();
const config = loadConfig({ production: true });
const result = await checkProductionReadiness({ config });
console.log(
  JSON.stringify(
    {
      ...result,
      databaseWrite: false,
      note: "Configuration, executables, project manifests and database connectivity passed; no migration was executed.",
    },
    null,
    2,
  ),
);

import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { checkProductionReadiness } from "../src/production-readiness.mjs";

await applyProductionConfigFile();
const config = loadConfig({ production: true });
const readiness = await checkProductionReadiness({
  config,
  allowPendingMigrations: true,
});
console.log(
  JSON.stringify(
    {
      ...readiness,
      databaseWrite: false,
      note: "预检只校验迁移计划，不执行迁移；db:migrate 仍是独立受控步骤。",
    },
    null,
    2,
  ),
);

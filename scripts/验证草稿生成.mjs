import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { runStructuredDraftProbe } from "../src/codex-draft-probe.mjs";

if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
  await applyProductionConfigFile();
}
const config = loadConfig({ requireTargets: false });
const result = await runStructuredDraftProbe({ codexPath: config.codexPath });
console.log(JSON.stringify(result, null, 2));

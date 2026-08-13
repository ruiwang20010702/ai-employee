import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { loadConfig } from "../src/config.mjs";
import {
  applyHistoricalProjectImport,
  previewHistoricalProjectImport,
} from "../src/historical-project-import-service.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { createProductionStore } from "../src/production-store.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const apply = args.includes("--apply");
const bundleInput = value("--bundle");
const confirmation = value("--confirmation");
if (!bundleInput || !isAbsolute(bundleInput)) {
  throw new Error(
    "Usage: 导入历史项目.mjs --bundle <absolute.json> [--apply --confirmation IMPORT-XXXXXXXXXXXX]",
  );
}
const inputMetadata = await lstat(bundleInput);
if (!inputMetadata.isFile() || inputMetadata.isSymbolicLink()) {
  throw new Error("Historical project import bundle must be a regular file");
}
const bundlePath = await realpath(bundleInput);
const metadata = await lstat(bundlePath);
if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
  throw new Error("Historical project import bundle must be a regular JSON file up to 1 MiB");
}
let bundle;
try {
  bundle = JSON.parse(await readFile(bundlePath, "utf8"));
} catch {
  throw new Error("Historical project import bundle is not valid JSON");
}
if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: apply });
let store = null;
try {
  const hasDatabase = Boolean(config.databaseUrl && config.dataKey && config.tenantId);
  if (apply || hasDatabase) {
    store = await createProductionStore(config, { readOnly: !apply });
  }
  const result = apply
    ? await applyHistoricalProjectImport({
        bundle,
        projectsDirectory: config.projectsDirectory,
        store,
        confirmation,
        actor: config.approver,
      })
    : await previewHistoricalProjectImport({
        bundle,
        projectsDirectory: config.projectsDirectory,
        store,
      });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store?.close();
}

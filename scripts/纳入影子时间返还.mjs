import { isAbsolute } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { createProductionStore } from "../src/production-store.mjs";
import {
  applyShadowTimeReturnAdmission,
  previewShadowTimeReturnAdmission,
} from "../src/shadow-time-return-admission.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const known = new Set([
  "--evidence-directory",
  "--evidence-sha256",
  "--apply",
  "--confirmation",
]);
for (let index = 0; index < args.length; index += 1) {
  const name = args[index];
  if (!known.has(name)) throw new Error(`Unknown option: ${name}`);
  if (name !== "--apply") index += 1;
}
const evidenceDirectory = value("--evidence-directory");
const evidenceSha256 = value("--evidence-sha256");
const confirmation = value("--confirmation");
const apply = args.includes("--apply");
if (!evidenceDirectory || !isAbsolute(evidenceDirectory) || !evidenceSha256) {
  throw new Error(
    "Usage: 纳入影子时间返还.mjs --evidence-directory <absolute> --evidence-sha256 <64_HEX> [--apply --confirmation ADMIT-XXXXXXXXXXXX]",
  );
}
if (apply !== Boolean(confirmation)) {
  throw new Error("--apply and --confirmation must be supplied together");
}

if (apply && process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: apply });
let store = null;
try {
  if (apply) store = await createProductionStore(config);
  const result = apply
    ? await applyShadowTimeReturnAdmission({
        evidenceDirectory,
        evidenceSha256,
        projectsDirectory: config.projectsDirectory,
        recipesDirectory: config.recipesDirectory,
        store,
        confirmation,
        actor: config.approver,
      })
    : await previewShadowTimeReturnAdmission({
        evidenceDirectory,
        evidenceSha256,
        projectsDirectory: config.projectsDirectory,
        recipesDirectory: config.recipesDirectory,
      });
  const { proof: _proof, ...publicResult } = result;
  console.log(JSON.stringify(publicResult, null, 2));
} finally {
  await store?.close();
}

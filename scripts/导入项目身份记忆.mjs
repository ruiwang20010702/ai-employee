import { fileURLToPath } from "node:url";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { createProductionStore } from "../src/production-store.mjs";
import {
  applyProjectIdentityRegistry,
  loadProjectIdentityRegistry,
} from "../src/project-identity-registry.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const apply = args.includes("--apply");
await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const registry = await loadProjectIdentityRegistry(
  value("--registry") ?? fileURLToPath(
    new URL("../deploy/project-identities.json", import.meta.url),
  ),
);
const store = await createProductionStore(config);
try {
  const result = await applyProjectIdentityRegistry({
    store,
    registry,
    actor: config.approver,
    confirmation: value("--confirmation"),
    apply,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store.close();
}

import { loadConfig } from "../src/config.mjs";
import { createStructuredArtifactRuntime } from "../src/artifact-runtime.mjs";
import {
  applyProjectMemorySync,
  previewProjectMemorySync,
} from "../src/project-memory-sync.mjs";
import { loadProjectManifests } from "../src/project-manifests.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { createProductionStore } from "../src/production-store.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const apply = args.includes("--apply");
const projectId = String(value("--project") ?? "").trim();
const requestedRuntime = value("--runtime");
const confirmation = value("--confirmation");
if (!projectId) {
  throw new Error(
    "Usage: 同步项目记忆.mjs --project <project-id> [--runtime codex|claude-code] [--apply] [--confirmation SYNC-XXXXXXXXXXXX]",
  );
}
if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: apply });
const projects = await loadProjectManifests(config.projectsDirectory);
const project = projects.get(projectId);
if (!project) throw new Error(`Project not found: ${projectId}`);
const runtimeId = requestedRuntime ?? config.agentRuntime;
const runtime = createStructuredArtifactRuntime({
  runtime: runtimeId,
  codexPath: config.codexPath,
  claudeCodePath: config.claudeCodePath,
});
let store = null;
try {
  const hasDatabase = Boolean(config.databaseUrl && config.dataKey && config.tenantId);
  if (apply || hasDatabase) {
    store = await createProductionStore(config, { readOnly: !apply });
  }
  const generated = await previewProjectMemorySync({ project, store, runtime });
  const result = apply
    ? await applyProjectMemorySync({
        generated,
        project,
        store,
        capabilities: config.capabilities,
        confirmation,
        actor: config.approver,
      })
    : generated.preview;
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store?.close();
}

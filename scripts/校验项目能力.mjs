import { loadConfig } from "../src/config.mjs";
import { loadProjectManifests } from "../src/project-manifests.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

if (process.env.AI_EMPLOYEE_CONFIG_FILE) await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: false });
const projects = await loadProjectManifests(config.projectsDirectory);
console.log(JSON.stringify({ valid: true, projects: projects.size }));

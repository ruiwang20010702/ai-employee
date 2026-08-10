import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { fileURLToPath } from "node:url";
import {
  deploymentVerificationTimeout,
  evaluateDeploymentHealth,
} from "../src/deployment-health.mjs";
import { verifyLoadedLaunchAgents } from "../src/launch-agent-verification.mjs";
import {
  serviceDefinitions,
  serviceScriptPath,
} from "./管理常驻服务.mjs";

if (!process.env.AI_EMPLOYEE_CONFIG_FILE) {
  throw new Error("AI_EMPLOYEE_CONFIG_FILE is required for service verification");
}
await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const expectedReleaseDirectory =
  process.env.AI_EMPLOYEE_EXPECTED_RELEASE_DIRECTORY ??
  fileURLToPath(new URL("../", import.meta.url));
const healthHost =
  config.healthHost === "0.0.0.0" || config.healthHost === "::"
    ? "127.0.0.1"
    : config.healthHost;
const healthBase = `http://${healthHost}:${config.healthPort}`;
const headers = config.healthAuthToken
  ? { authorization: `Bearer ${config.healthAuthToken}` }
  : {};
const deadline = Date.now() + deploymentVerificationTimeout(
  process.env.AI_EMPLOYEE_SERVICE_VERIFY_TIMEOUT_MS,
);
let lastResult = null;

async function json(response) {
  return response.json().catch(() => null);
}

while (Date.now() < deadline) {
  try {
    const [live, ready, admin, releaseServices] = await Promise.all([
      fetch(`${healthBase}/live`, { signal: AbortSignal.timeout(5_000) }),
      fetch(`${healthBase}/ready`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }),
      fetch(`http://${config.adminHost}:${config.adminPort}/`, {
        signal: AbortSignal.timeout(5_000),
      }),
      verifyLoadedLaunchAgents({
        definitions: serviceDefinitions,
        releaseDirectory: expectedReleaseDirectory,
        configPath: process.env.AI_EMPLOYEE_CONFIG_FILE,
        scriptPathFor: serviceScriptPath,
      }),
    ]);
    lastResult = evaluateDeploymentHealth({
      liveStatus: live.status,
      liveBody: await json(live),
      readyStatus: ready.status,
      readyBody: await json(ready),
      adminStatus: admin.status,
      releaseServices,
    });
    if (lastResult.verified) {
      console.log(JSON.stringify(lastResult, null, 2));
      process.exit(0);
    }
  } catch {
    lastResult = {
      verified: false,
      serviceAvailable: false,
      businessReady: false,
      failures: ["service_request_failed"],
      blockers: [],
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

console.error(JSON.stringify(lastResult, null, 2));
process.exitCode = 1;

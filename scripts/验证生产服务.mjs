import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";

await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const host =
  config.healthHost === "0.0.0.0" || config.healthHost === "::"
    ? "127.0.0.1"
    : config.healthHost;
const url = `http://${host}:${config.healthPort}/ready`;
const headers = config.healthAuthToken
  ? { authorization: `Bearer ${config.healthAuthToken}` }
  : {};
const deadline = Date.now() + Number(process.env.AI_EMPLOYEE_VERIFY_TIMEOUT_MS ?? 90_000);
let lastStatus = "service did not respond";

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    if (response.ok && body.status === "ready") {
      console.log(JSON.stringify({ verified: true }));
      process.exit(0);
    }
    lastStatus = `HTTP ${response.status}`;
  } catch {
    lastStatus = "request failed";
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
throw new Error(`Production verification failed: ${lastStatus}`);

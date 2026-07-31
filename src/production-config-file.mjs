import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const productionConfigKeys = new Set([
  "DATABASE_URL",
  "DATABASE_SSL",
  "DATABASE_POOL_MAX",
  "AI_EMPLOYEE_DATA_KEY",
  "AI_EMPLOYEE_TENANT_ID",
  "DINGTALK_TARGET_USER_IDS",
  "DINGTALK_SELF_USER_ID",
  "DINGTALK_DEBOUNCE_MS",
  "DINGTALK_FALLBACK_MS",
  "DINGTALK_QUIET_WINDOW_MS",
  "DINGTALK_INITIAL_LOOKBACK_HOURS",
  "DINGTALK_FETCH_OVERLAP_MS",
  "DWS_PATH",
  "CODEX_PATH",
  "AI_EMPLOYEE_WORKER_POLL_MS",
  "AI_EMPLOYEE_MAX_TASK_ATTEMPTS",
  "AI_EMPLOYEE_ALLOWED_CAPABILITIES",
  "AI_EMPLOYEE_APPROVER",
  "AI_EMPLOYEE_HEARTBEAT_MS",
  "AI_EMPLOYEE_HEARTBEAT_STALE_MS",
  "AI_EMPLOYEE_HEALTH_HOST",
  "AI_EMPLOYEE_HEALTH_PORT",
  "AI_EMPLOYEE_HEALTH_AUTH_TOKEN",
  "AI_EMPLOYEE_REQUIRED_COMPONENTS",
  "AI_EMPLOYEE_BACKUP_KEY",
  "AI_EMPLOYEE_BACKUP_DIRECTORY",
  "PG_DUMP_PATH",
  "PG_RESTORE_PATH",
]);

export function defaultProductionConfigPath() {
  return fileURLToPath(
    new URL("../.runtime/production.json", import.meta.url),
  );
}

export async function applyProductionConfigFile({
  path = process.env.AI_EMPLOYEE_CONFIG_FILE ??
    defaultProductionConfigPath(),
  environment = process.env,
} = {}) {
  const configPath = resolve(path);
  const metadata = await stat(configPath);
  if (!metadata.isFile()) {
    throw new Error("Production config must be a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Production config must not be readable by group or others");
  }
  const values = JSON.parse(await readFile(configPath, "utf8"));
  if (!values || Array.isArray(values) || typeof values !== "object") {
    throw new Error("Production config must be a JSON object");
  }
  for (const [key, value] of Object.entries(values)) {
    if (!productionConfigKeys.has(key)) {
      throw new Error(`Unsupported config key: ${key}`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Config value must be scalar: ${key}`);
    }
    environment[key] = String(value);
  }
  return { configPath, values };
}

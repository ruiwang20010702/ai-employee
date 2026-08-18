import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSecretReference,
  resolveSecretReference,
  secretConfigKeys,
} from "./secret-provider.mjs";

export const productionConfigKeys = new Set([
  "DATABASE_URL",
  "DATABASE_SSL",
  "DATABASE_POOL_MAX",
  "AI_EMPLOYEE_DATA_KEY",
  "AI_EMPLOYEE_TENANT_ID",
  "DINGTALK_TARGET_USER_IDS",
  "DINGTALK_TARGET_GROUP_IDS",
  "DINGTALK_SELF_USER_ID",
  "AI_EMPLOYEE_PROJECTS_DIRECTORY",
  "DINGTALK_DEBOUNCE_MS",
  "DINGTALK_FALLBACK_MS",
  "DINGTALK_QUIET_WINDOW_MS",
  "AI_EMPLOYEE_BUNDLE_MAX_WAIT_MS",
  "AI_EMPLOYEE_BUNDLE_GAP_MS",
  "AI_EMPLOYEE_MAX_MESSAGES_PER_TASK",
  "DINGTALK_INITIAL_LOOKBACK_HOURS",
  "DINGTALK_FETCH_OVERLAP_MS",
  "DWS_PATH",
  "CODEX_PATH",
  "CLAUDE_CODE_PATH",
  "AI_EMPLOYEE_AGENT_RUNTIME",
  "GBRAIN_PATH",
  "AI_EMPLOYEE_GBRAIN_HOME",
  "AI_EMPLOYEE_GBRAIN_DATABASE_URL",
  "GH_PATH",
  "FOURSDAY_PROACTIVE_POLL_MS",
  "AI_EMPLOYEE_WORKER_POLL_MS",
  "AI_EMPLOYEE_WORKER_CONCURRENCY",
  "AI_EMPLOYEE_PLAN_EXECUTOR_POLL_MS",
  "AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS",
  "AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS",
  "AI_EMPLOYEE_MANUAL_REPLY_RECHECK_MS",
  "AI_EMPLOYEE_RECONCILIATION_WINDOW_MS",
  "AI_EMPLOYEE_RECONCILIATION_GRACE_MS",
  "AI_EMPLOYEE_RECONCILIATION_LIMIT",
  "AI_EMPLOYEE_RECONCILIATION_STALE_MS",
  "AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS",
  "AI_EMPLOYEE_MEMORY_SOURCE_LIMIT",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_MAX_PROJECT_FACTS",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_MODE",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_WRITE",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_AUTO_CONFIRM_MIN_CONFIDENCE",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_ROOT",
  "AI_EMPLOYEE_MEMORY_AUTHORITY_SOURCE_ID",
  "AI_EMPLOYEE_PERSONAL_MEMORY_ENABLED",
  "AI_EMPLOYEE_PERSONAL_MEMORY_MCP_URL",
  "AI_EMPLOYEE_PERSONAL_MEMORY_ISSUER_URL",
  "AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_ID",
  "AI_EMPLOYEE_PERSONAL_MEMORY_CLIENT_SECRET",
  "AI_EMPLOYEE_PERSONAL_MEMORY_TIMEOUT_MS",
  "AI_EMPLOYEE_PERSONAL_MEMORY_MAX_RESULTS",
  "AI_EMPLOYEE_REQUIRE_MESSAGE_RECONCILIATION",
  "AI_EMPLOYEE_REPLY_MAX_AGE_MS",
  "AI_EMPLOYEE_WAITING_INFORMATION_TTL_MS",
  "AI_EMPLOYEE_DRAFT_APPROVAL_TTL_MS",
  "AI_EMPLOYEE_MAX_TASK_ATTEMPTS",
  "AI_EMPLOYEE_SHADOW_MIN_SAMPLES",
  "AI_EMPLOYEE_SHADOW_MIN_REPLY_ACCURACY",
  "AI_EMPLOYEE_SHADOW_MIN_NO_REPLY_ACCURACY",
  "AI_EMPLOYEE_SHADOW_MIN_DRAFT_SAMPLES",
  "AI_EMPLOYEE_SHADOW_MIN_DRAFT_USABILITY",
  "AI_EMPLOYEE_ALLOWED_CAPABILITIES",
  "AI_EMPLOYEE_AUTO_APPROVE_LOW_RISK_REPLIES",
  "AI_EMPLOYEE_AUTO_APPROVE_MIN_CONFIDENCE",
  "AI_EMPLOYEE_AUTO_APPROVE_GROUP_REPLIES",
  "AI_EMPLOYEE_AUTO_APPROVE_CLARIFICATIONS",
  "AI_EMPLOYEE_MOBILE_APPROVAL_ENABLED",
  "AI_EMPLOYEE_MOBILE_APPROVAL_NOTIFY_INTERVAL_MS",
  "AI_EMPLOYEE_APPROVER",
  "AI_EMPLOYEE_HEARTBEAT_MS",
  "AI_EMPLOYEE_HEARTBEAT_STALE_MS",
  "AI_EMPLOYEE_EXTERNAL_CHECK_STALE_MS",
  "AI_EMPLOYEE_HEALTH_HOST",
  "AI_EMPLOYEE_HEALTH_PORT",
  "AI_EMPLOYEE_HEALTH_AUTH_TOKEN",
  "AI_EMPLOYEE_ADMIN_HOST",
  "AI_EMPLOYEE_ADMIN_PORT",
  "AI_EMPLOYEE_ADMIN_READ_TOKEN",
  "AI_EMPLOYEE_ADMIN_WRITE_TOKEN",
  "AI_EMPLOYEE_ADMIN_LOGIN_IDENTIFIERS",
  "AI_EMPLOYEE_ADMIN_PASSWORD_HASH",
  "AI_EMPLOYEE_ADMIN_SESSION_TTL_MS",
  "AI_EMPLOYEE_ALERT_WEBHOOK_URL",
  "AI_EMPLOYEE_ALERT_WEBHOOK_SECRET",
  "AI_EMPLOYEE_ALERT_INTERVAL_MS",
  "AI_EMPLOYEE_ALERT_COOLDOWN_MS",
  "AI_EMPLOYEE_AVAILABILITY_SAMPLE_INTERVAL_MS",
  "AI_EMPLOYEE_AVAILABILITY_WINDOW_MS",
  "AI_EMPLOYEE_AVAILABILITY_RETENTION_MS",
  "AI_EMPLOYEE_REQUIRED_COMPONENTS",
  "AI_EMPLOYEE_REQUIRED_OPERATIONAL_CHECKS",
  "AI_EMPLOYEE_BACKUP_KEY",
  "AI_EMPLOYEE_BACKUP_DIRECTORY",
  "PG_DUMP_PATH",
  "PG_RESTORE_PATH",
]);

const personalGbrainEnvironmentKeys = Object.freeze([
  "GBRAIN_REMOTE_TOKEN",
  "GBRAIN_REMOTE_URL",
  "GBRAIN_HOME",
  "GBRAIN_DATABASE_URL",
  "GBRAIN_SOURCE",
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
  secretResolverOptions = {},
  resolveSecrets = true,
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
  const sourceEnvironment = { ...environment };
  const stagedEnvironment = {};
  const resolvedSecretKeys = [];
  for (const [key, value] of Object.entries(values)) {
    if (!productionConfigKeys.has(key)) {
      throw new Error(`Unsupported config key: ${key}`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Config value must be scalar: ${key}`);
    }
    if (isSecretReference(value) && !secretConfigKeys.has(key)) {
      throw new Error(`Secret references are not allowed for config key: ${key}`);
    }
    if (
      secretConfigKeys.has(key) &&
      resolveSecrets &&
      !isSecretReference(value)
    ) {
      throw new Error(`Production secret must use an external reference: ${key}`);
    }
    if (secretConfigKeys.has(key) && resolveSecrets) {
      const resolved = await resolveSecretReference(String(value), {
        environment: sourceEnvironment,
        ...secretResolverOptions,
      });
      stagedEnvironment[key] = resolved.value;
      if (resolved.source !== "inline") resolvedSecretKeys.push(key);
    } else {
      stagedEnvironment[key] = String(value);
    }
  }
  for (const key of personalGbrainEnvironmentKeys) delete environment[key];
  Object.assign(environment, stagedEnvironment);
  return { configPath, values, resolvedSecretKeys };
}

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function positiveInteger(name, fallback) {
  const value = positiveNumber(name, fallback);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function portNumber(name, fallback) {
  const value = positiveInteger(name, fallback);
  if (value > 65_535) throw new Error(`${name} must be <= 65535`);
  return value;
}

function fraction(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function commaSeparated(name, fallback = "") {
  return String(process.env[name] ?? fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function assertConfiguredIdentifier(name, value, { required = true } = {}) {
  if (!value) {
    if (required) throw new Error(`${name} is required in production mode`);
    return;
  }
  if (/^(?:replace_with|change_me)(?:_|$)/iu.test(value)) {
    throw new Error(`${name} still contains a placeholder`);
  }
}

export function loadConfig({
  requireTargets = true,
  production = false,
} = {}) {
  const targetUserIds = [
    ...new Set([
      ...commaSeparated("DINGTALK_TARGET_USER_IDS"),
      ...commaSeparated("DINGTALK_TARGET_USER_ID"),
    ]),
  ];
  const targetGroupIds = [
    ...new Set(commaSeparated("DINGTALK_TARGET_GROUP_IDS")),
  ];

  if (requireTargets && targetUserIds.length === 0 && targetGroupIds.length === 0) {
    throw new Error(
      "At least one DingTalk user or group target is required",
    );
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() || null;
  const dataKey = process.env.AI_EMPLOYEE_DATA_KEY?.trim() || null;
  const tenantId = process.env.AI_EMPLOYEE_TENANT_ID?.trim() || null;
  const selfUserId = process.env.DINGTALK_SELF_USER_ID?.trim() || null;
  const approver = process.env.AI_EMPLOYEE_APPROVER?.trim() || null;
  if (production && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production mode");
  }
  if (production && !dataKey) {
    throw new Error("AI_EMPLOYEE_DATA_KEY is required in production mode");
  }
  if (production && !tenantId) {
    throw new Error("AI_EMPLOYEE_TENANT_ID is required in production mode");
  }
  if (production) {
    assertConfiguredIdentifier("AI_EMPLOYEE_TENANT_ID", tenantId);
    assertConfiguredIdentifier("AI_EMPLOYEE_APPROVER", approver);
    assertConfiguredIdentifier("DINGTALK_SELF_USER_ID", selfUserId, {
      required: requireTargets,
    });
    for (const value of targetUserIds) {
      assertConfiguredIdentifier("DINGTALK_TARGET_USER_IDS", value);
    }
    for (const value of targetGroupIds) {
      assertConfiguredIdentifier("DINGTALK_TARGET_GROUP_IDS", value);
    }
  }
  if (production && requireTargets && !selfUserId) {
    throw new Error(
      "DINGTALK_SELF_USER_ID is required for manual reply protection",
    );
  }
  const planExecutionLeaseMs = positiveNumber(
    "AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS",
    300_000,
  );
  const planExecutionLeaseRenewMs = positiveNumber(
    "AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS",
    60_000,
  );
  if (planExecutionLeaseRenewMs >= planExecutionLeaseMs) {
    throw new Error(
      "AI_EMPLOYEE_PLAN_EXECUTION_LEASE_RENEW_MS must be shorter than AI_EMPLOYEE_PLAN_EXECUTION_LEASE_MS",
    );
  }
  const reconciliationWindowMs = positiveNumber(
    "AI_EMPLOYEE_RECONCILIATION_WINDOW_MS",
    86_400_000,
  );
  const reconciliationGraceMs = positiveNumber(
    "AI_EMPLOYEE_RECONCILIATION_GRACE_MS",
    120_000,
  );
  if (reconciliationGraceMs >= reconciliationWindowMs) {
    throw new Error(
      "AI_EMPLOYEE_RECONCILIATION_GRACE_MS must be shorter than AI_EMPLOYEE_RECONCILIATION_WINDOW_MS",
    );
  }
  const reconciliationLimit = positiveInteger(
    "AI_EMPLOYEE_RECONCILIATION_LIMIT",
    10_000,
  );
  if (reconciliationLimit > 100_000) {
    throw new Error("AI_EMPLOYEE_RECONCILIATION_LIMIT must be <= 100000");
  }
  const memorySourceLeaseMs = positiveNumber(
    "AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS",
    900_000,
  );
  if (memorySourceLeaseMs < 600_000 || memorySourceLeaseMs > 3_600_000) {
    throw new Error("AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS must be 600000-3600000");
  }
  const memorySourceLimit = positiveInteger(
    "AI_EMPLOYEE_MEMORY_SOURCE_LIMIT",
    500,
  );
  if (memorySourceLimit > 5_000) {
    throw new Error("AI_EMPLOYEE_MEMORY_SOURCE_LIMIT must be <= 5000");
  }
  const alertIntervalMs = positiveNumber(
    "AI_EMPLOYEE_ALERT_INTERVAL_MS",
    60_000,
  );
  const availabilitySampleIntervalMs = positiveInteger(
    "AI_EMPLOYEE_AVAILABILITY_SAMPLE_INTERVAL_MS",
    60_000,
  );
  const availabilityWindowMs = positiveInteger(
    "AI_EMPLOYEE_AVAILABILITY_WINDOW_MS",
    30 * 24 * 60 * 60 * 1000,
  );
  const availabilityRetentionMs = positiveInteger(
    "AI_EMPLOYEE_AVAILABILITY_RETENTION_MS",
    45 * 24 * 60 * 60 * 1000,
  );
  if (alertIntervalMs > availabilitySampleIntervalMs) {
    throw new Error(
      "AI_EMPLOYEE_ALERT_INTERVAL_MS must not exceed AI_EMPLOYEE_AVAILABILITY_SAMPLE_INTERVAL_MS",
    );
  }
  if (availabilityRetentionMs <= availabilityWindowMs) {
    throw new Error(
      "AI_EMPLOYEE_AVAILABILITY_RETENTION_MS must exceed AI_EMPLOYEE_AVAILABILITY_WINDOW_MS",
    );
  }
  const externalCheckStaleMs = positiveNumber(
    "AI_EMPLOYEE_EXTERNAL_CHECK_STALE_MS",
    600_000,
  );
  if (externalCheckStaleMs >= memorySourceLeaseMs) {
    throw new Error(
      "AI_EMPLOYEE_EXTERNAL_CHECK_STALE_MS must be shorter than AI_EMPLOYEE_MEMORY_SOURCE_LEASE_MS",
    );
  }
  const requiredComponents = commaSeparated(
    "AI_EMPLOYEE_REQUIRED_COMPONENTS",
    "listener,worker",
  );
  const capabilities = new Set(
    commaSeparated("AI_EMPLOYEE_ALLOWED_CAPABILITIES", "draft_reply"),
  );
  if (
    capabilities.has("work_plan_execution") &&
    !requiredComponents.includes("executor")
  ) {
    throw new Error(
      "work_plan_execution requires executor in AI_EMPLOYEE_REQUIRED_COMPONENTS",
    );
  }

  return {
    targetUserIds,
    targetGroupIds,
    approver: approver ?? "local-user",
    selfUserId,
    dwsPath: process.env.DWS_PATH ?? join(homedir(), ".local/bin/dws"),
    dwsMock: process.env.DWS_MOCK === "true",
    // Let the operating system resolve Codex from PATH by default. This works
    // for Homebrew on both Apple Silicon and Intel, npm global installs, and
    // managed installations. Production can still pin an absolute path.
    codexPath: process.env.CODEX_PATH ?? "codex",
    gbrainPath: process.env.GBRAIN_PATH ?? "gbrain",
    dingtalkRoot:
      process.env.DINGTALK_DATA_ROOT ??
      join(homedir(), "Library/Application Support/DingTalkMac"),
    projectsDirectory:
      process.env.AI_EMPLOYEE_PROJECTS_DIRECTORY ??
      join(projectRoot, ".runtime", "projects"),
    databaseUrl,
    dataKey,
    tenantId,
    databaseSsl: process.env.DATABASE_SSL === "true",
    databasePoolMax: positiveInteger("DATABASE_POOL_MAX", 10),
    fallbackMs: positiveNumber("DINGTALK_FALLBACK_MS", 300_000),
    debounceMs: positiveNumber("DINGTALK_DEBOUNCE_MS", 800),
    quietWindowMs: positiveNumber("DINGTALK_QUIET_WINDOW_MS", 3_000),
    bundleGapMs: positiveNumber("AI_EMPLOYEE_BUNDLE_GAP_MS", 120_000),
    maxMessagesPerTask: positiveInteger(
      "AI_EMPLOYEE_MAX_MESSAGES_PER_TASK",
      20,
    ),
    initialLookbackHours: positiveNumber(
      "DINGTALK_INITIAL_LOOKBACK_HOURS",
      72,
    ),
    overlapMs: positiveNumber("DINGTALK_FETCH_OVERLAP_MS", 600_000),
    workerPollMs: positiveNumber("AI_EMPLOYEE_WORKER_POLL_MS", 2_000),
    planExecutorPollMs: positiveNumber(
      "AI_EMPLOYEE_PLAN_EXECUTOR_POLL_MS",
      5_000,
    ),
    planExecutionLeaseMs,
    planExecutionLeaseRenewMs,
    manualReplyRecheckMs: positiveNumber(
      "AI_EMPLOYEE_MANUAL_REPLY_RECHECK_MS",
      60_000,
    ),
    reconciliationWindowMs,
    reconciliationGraceMs,
    reconciliationLimit,
    reconciliationStaleMs: positiveNumber(
      "AI_EMPLOYEE_RECONCILIATION_STALE_MS",
      7_200_000,
    ),
    memorySourceLeaseMs,
    memorySourceLimit,
    requireMessageReconciliation: boolean(
      "AI_EMPLOYEE_REQUIRE_MESSAGE_RECONCILIATION",
      false,
    ),
    replyMaxAgeMs: positiveNumber("AI_EMPLOYEE_REPLY_MAX_AGE_MS", 7_200_000),
    draftApprovalTtlMs: positiveNumber(
      "AI_EMPLOYEE_DRAFT_APPROVAL_TTL_MS",
      7_200_000,
    ),
    heartbeatMs: positiveNumber("AI_EMPLOYEE_HEARTBEAT_MS", 30_000),
    heartbeatStaleMs: positiveNumber(
      "AI_EMPLOYEE_HEARTBEAT_STALE_MS",
      90_000,
    ),
    externalCheckStaleMs,
    healthHost: process.env.AI_EMPLOYEE_HEALTH_HOST ?? "127.0.0.1",
    healthPort: portNumber("AI_EMPLOYEE_HEALTH_PORT", 9464),
    healthAuthToken: process.env.AI_EMPLOYEE_HEALTH_AUTH_TOKEN?.trim() || null,
    adminHost: process.env.AI_EMPLOYEE_ADMIN_HOST ?? "127.0.0.1",
    adminPort: portNumber("AI_EMPLOYEE_ADMIN_PORT", 9465),
    adminReadToken: process.env.AI_EMPLOYEE_ADMIN_READ_TOKEN?.trim() || null,
    adminWriteToken: process.env.AI_EMPLOYEE_ADMIN_WRITE_TOKEN?.trim() || null,
    alertWebhookUrl: process.env.AI_EMPLOYEE_ALERT_WEBHOOK_URL?.trim() || null,
    alertWebhookSecret:
      process.env.AI_EMPLOYEE_ALERT_WEBHOOK_SECRET?.trim() || null,
    alertIntervalMs,
    availabilitySampleIntervalMs,
    availabilityWindowMs,
    availabilityRetentionMs,
    alertCooldownMs: positiveNumber(
      "AI_EMPLOYEE_ALERT_COOLDOWN_MS",
      900_000,
    ),
    requiredComponents,
    requiredOperationalChecks: commaSeparated(
      "AI_EMPLOYEE_REQUIRED_OPERATIONAL_CHECKS",
      "listener:last-full-success,worker:manual-reply:last-success,memory-source:last-success",
    ),
    maxTaskAttempts: positiveInteger("AI_EMPLOYEE_MAX_TASK_ATTEMPTS", 5),
    shadowMinimumSamples: positiveInteger(
      "AI_EMPLOYEE_SHADOW_MIN_SAMPLES",
      100,
    ),
    shadowMinimumReplyAccuracy: fraction(
      "AI_EMPLOYEE_SHADOW_MIN_REPLY_ACCURACY",
      0.95,
    ),
    shadowMinimumNoReplyAccuracy: fraction(
      "AI_EMPLOYEE_SHADOW_MIN_NO_REPLY_ACCURACY",
      0.95,
    ),
    shadowMinimumDraftSamples: positiveInteger(
      "AI_EMPLOYEE_SHADOW_MIN_DRAFT_SAMPLES",
      30,
    ),
    shadowMinimumDraftUsability: fraction(
      "AI_EMPLOYEE_SHADOW_MIN_DRAFT_USABILITY",
      0.9,
    ),
    capabilities,
    debugContent: process.env.AI_EMPLOYEE_DEBUG_CONTENT === "true",
  };
}

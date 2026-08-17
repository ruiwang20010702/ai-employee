import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkPostgres, createPostgresPool } from "./postgres.mjs";
import { loadProjectManifests } from "./project-manifests.mjs";
import { safeCodexEnvironment } from "./codex-environment.mjs";
import {
  assertMigrationStatus,
  inspectMigrationStatus,
} from "./migration-status.mjs";
import { createAdminSessionManager } from "./admin-session-auth.mjs";
import { resolveGbrainPath } from "./gbrain-page.mjs";

const execFileAsync = promisify(execFile);

export function validateBase64Key(name, value) {
  if (!value) throw new Error(`${name} is required`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be a canonical base64 encoded 32-byte key`);
  }
}

export function validateLongToken(name, value) {
  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  if (/replace|change_me|example/iu.test(value)) {
    throw new Error(`${name} still contains a placeholder`);
  }
}

export async function requireExecutable(name, path) {
  const check = path.includes("/")
    ? access(path, constants.X_OK)
    : execFileAsync("/usr/bin/which", [path]);
  await check.catch(() => {
    throw new Error(`${name} is not executable or discoverable in PATH: ${path}`);
  });
}

export async function checkCodexRuntime(
  codexPath,
  run = execFileAsync,
) {
  let parsed;
  try {
    const { stdout } = await run(codexPath, ["doctor", "--json"], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: safeCodexEnvironment(codexPath),
    });
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Codex runtime doctor failed");
  }
  const checks = parsed?.checks && !Array.isArray(parsed.checks)
    ? Object.entries(parsed.checks)
    : [];
  const warningChecks = checks.filter(([, check]) => check?.status === "warning");
  const advisories = warningChecks.map(([name]) => name);
  const allowedAdvisory = ([name, check]) =>
    name === "updates.status" ||
    (
      name === "mcp.config" &&
      check?.summary === "MCP configuration has optional issues"
    );
  const onlyAllowedAdvisories =
    parsed?.overallStatus === "warning" &&
    checks.length > 0 &&
    advisories.length > 0 &&
    warningChecks.every(allowedAdvisory) &&
    checks.every(([, check]) => ["ok", "warning"].includes(check?.status));
  if (parsed?.overallStatus !== "ok" && !onlyAllowedAdvisories) {
    throw new Error("Codex runtime doctor reported a non-ok status");
  }
  return {
    status: parsed.overallStatus,
    version: parsed.codexVersion ?? null,
    advisories,
  };
}

export async function checkClaudeCodeRuntime(
  claudeCodePath,
  run = execFileAsync,
) {
  let version;
  try {
    const { stdout } = await run(claudeCodePath, ["--version"], {
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      env: safeCodexEnvironment(claudeCodePath),
    });
    version = String(stdout).trim().match(/^(\d+\.\d+\.\d+)/u)?.[1] ?? null;
  } catch {
    throw new Error("Claude Code runtime version check failed");
  }
  if (!version) {
    throw new Error("Claude Code runtime returned an invalid version");
  }
  return { status: "ok", version, advisories: [] };
}

export async function checkDwsRuntime(
  dwsPath,
  run = execFileAsync,
) {
  let parsed;
  try {
    const { stdout } = await run(
      dwsPath,
      ["auth", "status", "--format", "json"],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: safeCodexEnvironment(dwsPath),
      },
    );
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("DWS authentication status check failed");
  }
  if (
    parsed?.success !== true ||
    parsed?.authenticated !== true ||
    parsed?.token_valid !== true ||
    parsed?.refresh_token_valid !== true
  ) {
    throw new Error("DWS authentication is not ready");
  }
  return {
    authenticated: true,
    tokenValid: true,
    refreshTokenValid: true,
  };
}

export async function checkGbrainRuntime(
  gbrainPath,
  run = execFileAsync,
) {
  let version;
  try {
    const executable = run === execFileAsync
      ? await resolveGbrainPath(gbrainPath)
      : gbrainPath;
    const { stdout } = await run(executable, ["version"], {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      env: safeCodexEnvironment(executable),
    });
    version = String(stdout).trim().match(/^gbrain\s+([^\s]+)/u)?.[1] ?? null;
  } catch {
    throw new Error("gbrain runtime version check failed");
  }
  if (!version) throw new Error("gbrain runtime returned an invalid version");
  return { required: true, version };
}

export function validateProductionReadinessConfig(
  config,
  environment = process.env,
) {
  if ((config.memoryAuthorityMode ?? "gbrain") !== "gbrain") {
    throw new Error("Production memory authority must use gbrain");
  }
  if (config.memoryAuthorityAutoConfirm && !config.memoryAuthorityWrite) {
    throw new Error("Memory authority auto-confirm requires authority writes");
  }
  validateBase64Key("AI_EMPLOYEE_DATA_KEY", config.dataKey);
  validateBase64Key(
    "AI_EMPLOYEE_BACKUP_KEY",
    environment.AI_EMPLOYEE_BACKUP_KEY,
  );
  if (config.dataKey === environment.AI_EMPLOYEE_BACKUP_KEY) {
    throw new Error("Data and backup encryption keys must be different");
  }
  validateLongToken("AI_EMPLOYEE_ADMIN_READ_TOKEN", config.adminReadToken);
  validateLongToken("AI_EMPLOYEE_ADMIN_WRITE_TOKEN", config.adminWriteToken);
  if (config.adminReadToken === config.adminWriteToken) {
    throw new Error("Admin read and write tokens must be different");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(config.adminHost)) {
    throw new Error("AI_EMPLOYEE_ADMIN_HOST must remain loopback-only");
  }
  createAdminSessionManager({
    identifiers: config.adminLoginIdentifiers ?? [],
    passwordHash: config.adminPasswordHash ?? null,
    sessionTtlMs: config.adminSessionTtlMs ?? 28_800_000,
  });
  if (config.alertWebhookUrl) {
    const alertUrl = new URL(config.alertWebhookUrl);
    if (alertUrl.protocol !== "https:") {
      throw new Error("AI_EMPLOYEE_ALERT_WEBHOOK_URL must use HTTPS");
    }
    validateLongToken(
      "AI_EMPLOYEE_ALERT_WEBHOOK_SECRET",
      config.alertWebhookSecret,
    );
  }
  const database = new URL(config.databaseUrl);
  if (
    !["127.0.0.1", "::1", "localhost"].includes(database.hostname) &&
    !config.databaseSsl
  ) {
    throw new Error("DATABASE_SSL must be true for a remote PostgreSQL server");
  }
  if (!database.username || !database.password) {
    throw new Error("DATABASE_URL must contain a dedicated username and password");
  }
  if (/replace|change_me|example/iu.test(config.databaseUrl)) {
    throw new Error("DATABASE_URL still contains a placeholder");
  }
}

export async function checkProductionReadiness({
  config,
  environment = process.env,
  createPool = createPostgresPool,
  checkDatabase = checkPostgres,
  manifestLoader = loadProjectManifests,
  executableChecker = requireExecutable,
  codexChecker = checkCodexRuntime,
  claudeCodeChecker = checkClaudeCodeRuntime,
  dwsChecker = checkDwsRuntime,
  gbrainChecker = checkGbrainRuntime,
  migrationInspector = inspectMigrationStatus,
  allowPendingMigrations = false,
} = {}) {
  validateProductionReadinessConfig(config, environment);
  let projects = new Map();
  const sourceReconciliationRequired =
    config.requiredOperationalChecks?.includes("memory-source:last-success") ?? false;
  if (config.capabilities.has("work_plan_execution") || sourceReconciliationRequired) {
    projects = await manifestLoader(config.projectsDirectory);
    if (config.capabilities.has("work_plan_execution") && projects.size === 0) {
      throw new Error(
        "work_plan_execution requires at least one valid project manifest",
      );
    }
  }
  const gbrainRequired = (config.memoryAuthorityMode ?? "gbrain") === "gbrain" || [...projects.values()].some(
    (project) => project.capabilities.knowledge_read != null &&
      project.capabilities.knowledge_read.mode !== "disabled",
  );
  const selectedAgentRuntime = config.agentRuntime ?? "codex";
  const agentExecutable = selectedAgentRuntime === "claude-code"
    ? ["Claude Code", config.claudeCodePath]
    : ["Codex", config.codexPath];
  const executableChecks = [
    executableChecker("DWS", config.dwsPath),
    executableChecker(...agentExecutable),
    executableChecker("pg_dump", environment.PG_DUMP_PATH ?? "pg_dump"),
    executableChecker("pg_restore", environment.PG_RESTORE_PATH ?? "pg_restore"),
  ];
  if (gbrainRequired) {
    executableChecks.push(executableChecker("gbrain", config.gbrainPath));
  }
  await Promise.all(executableChecks);
  const [agentRuntime, dwsRuntime, gbrainRuntime] = await Promise.all([
    selectedAgentRuntime === "claude-code"
      ? claudeCodeChecker(config.claudeCodePath)
      : codexChecker(config.codexPath),
    dwsChecker(config.dwsPath),
    gbrainRequired
      ? gbrainChecker(config.gbrainPath)
      : Promise.resolve({ required: false }),
  ]);

  const pool = createPool(config);
  try {
    const database = await checkDatabase(pool);
    const migrations = await migrationInspector(pool);
    assertMigrationStatus(migrations, { allowPending: allowPendingMigrations });
    return {
      ready: true,
      database: database.database,
      migrations,
      targets: config.targetUserIds.length + config.targetGroupIds.length,
      capabilities: [...config.capabilities],
      agentRuntime: { id: selectedAgentRuntime, ...agentRuntime },
      codexRuntime: selectedAgentRuntime === "codex" ? agentRuntime : null,
      dwsRuntime,
      gbrainRuntime,
      memoryAuthority: {
        mode: config.memoryAuthorityMode ?? "gbrain",
        writeEnabled: config.memoryAuthorityWrite === true,
        autoConfirm: config.memoryAuthorityAutoConfirm === true,
        durableStore: "gbrain_markdown",
        runtimeStore: "postgresql",
      },
    };
  } finally {
    await pool.end();
  }
}

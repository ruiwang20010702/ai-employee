import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.mjs";
import {
  assertMigrationStatus,
  inspectMigrationStatus,
  listExpectedMigrations,
} from "./migration-status.mjs";
import { createPostgresPool } from "./postgres.mjs";
import {
  assertServiceRollbackState,
  inspectServiceRollbackState,
} from "./rollback-state-guard.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaVersion = "ai-employee-rollback-baseline/v1";
const continuationMigration = "017_等待信息任务链.sql";
const capabilityBudgetMigration = "018_能力次数预算.sql";
const capabilityBudgetGuard = "capability_budget_target_support_required";
const capabilityBudgetConstraint = "work_plans_capability_budget_required_check";
const capabilityBudgetRejectionCode =
  "service_rollback_capability_budget_unsupported";

export function validateRollbackTestUrl(value) {
  const source = String(value ?? "");
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("TEST_DATABASE_URL 必须是合法的本机 PostgreSQL 测试库地址");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("回退演练只支持 PostgreSQL 测试库");
  }
  if (source.includes("?") || source.includes("#")) {
    throw new Error("回退演练数据库地址不允许查询参数或片段");
  }
  if (!new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(url.hostname)) {
    throw new Error("回退演练只允许连接本机测试数据库");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!/^ai_employee(?:_[a-z0-9]+)*_test(?:_[a-z0-9]+)*$/u.test(database)) {
    throw new Error("回退演练数据库名称必须包含明确的 ai_employee_test 边界");
  }
  return url.toString();
}

export function validateRollbackManifest(value) {
  if (!value || value.schemaVersion !== schemaVersion) {
    throw new Error("回退基线清单版本无效");
  }
  validateRollbackBaseline(value, "回退基线");
  if (value.postGuardBaseline !== undefined) {
    validateRollbackBaseline(value.postGuardBaseline, "状态门禁后回退基线");
    if (value.postGuardBaseline.expectedMigrations <= value.expectedMigrations) {
      throw new Error("状态门禁后回退基线必须晚于历史回退基线");
    }
  }
  return value;
}

function validateRollbackBaseline(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(String(value.commit ?? ""))) {
    throw new Error(`${label}提交必须是完整 SHA`);
  }
  if (!Number.isSafeInteger(value.expectedMigrations) || value.expectedMigrations < 1) {
    throw new Error(`${label}迁移数量无效`);
  }
  if (value.testFile !== "test/postgres-store.integration.test.mjs") {
    throw new Error(`${label}测试入口不受支持`);
  }
  if (!String(value.reason ?? "").trim()) {
    throw new Error(`${label}必须说明选择原因`);
  }
}

export function countForwardMigrationFiles(output) {
  return listForwardMigrationFiles(output).length;
}

export function listForwardMigrationFiles(output) {
  return String(output)
    .split("\0")
    .filter((file) => file.endsWith(".sql") && !file.endsWith(".undo.sql"));
}

function migrationFilename(path) {
  return String(path).split("/").at(-1);
}

export function assertPostGuardBaseline({
  baselineMigrationFiles,
  expectedMigrations,
}) {
  const versions = baselineMigrationFiles.map(migrationFilename);
  if (
    versions.length !== expectedMigrations ||
    !versions.includes(continuationMigration) ||
    !versions.includes(capabilityBudgetMigration)
  ) {
    throw new Error("状态门禁后回退基线必须精确支持第 017 和 018 号迁移");
  }
  return versions;
}

export function buildRollbackVerificationPlan({
  migrations,
  baselineMigrationFiles,
  compatibilityPolicy,
}) {
  const baselineVersions = new Set(
    baselineMigrationFiles.map(migrationFilename),
  );
  const currentVersions = new Set(migrations.map((migration) => migration.version));
  for (const version of baselineVersions) {
    if (!currentVersions.has(version)) {
      throw new Error(`回退基线迁移不在当前清单中：${version}`);
    }
  }

  const legacyTestMigrations = [];
  const guardedMigrations = [];
  let guardedMigrationSeen = false;
  for (const migration of migrations) {
    if (baselineVersions.has(migration.version)) {
      if (guardedMigrationSeen) {
        throw new Error("回退基线迁移顺序无效");
      }
      legacyTestMigrations.push(migration);
      continue;
    }
    const entry = compatibilityPolicy?.migrations?.[migration.version];
    if (entry?.rollback === "service_only") {
      if (guardedMigrationSeen) {
        throw new Error(
          `普通服务回退迁移位于状态门禁之后，无法保留独立旧服务证据：${migration.version}`,
        );
      }
      legacyTestMigrations.push(migration);
      continue;
    }
    if (entry?.rollback === "service_only_with_state_guard") {
      guardedMigrationSeen = true;
      guardedMigrations.push({
        version: migration.version,
        guard: entry.guard,
      });
      continue;
    }
    throw new Error(`服务回退迁移策略不受支持：${migration.version}`);
  }

  const targetSupportsContinuation = baselineVersions.has(continuationMigration);
  const targetSupportsCapabilityBudget = baselineVersions.has(
    capabilityBudgetMigration,
  );
  return {
    legacyTestMigrations,
    guardedMigrations,
    targetSupportsContinuation,
    targetSupportsCapabilityBudget,
    requiresCapabilityBudgetPersistenceProbe: migrations.some(
      (migration) =>
        migration.version === capabilityBudgetMigration &&
        compatibilityPolicy?.migrations?.[migration.version]?.guard ===
          capabilityBudgetGuard,
    ),
  };
}

export function assertLegacyCompatibilityBoundary(status, verificationPlan) {
  const expectedPending = verificationPlan.guardedMigrations.map(
    (migration) => migration.version,
  );
  const pendingMatches = status.pending.length === expectedPending.length &&
    status.pending.every((version, index) => version === expectedPending[index]);
  if (
    !status.tablePresent ||
    status.applied !== verificationPlan.legacyTestMigrations.length ||
    !pendingMatches ||
    status.unexpected.length > 0
  ) {
    throw new Error("旧服务全量测试的迁移阶段边界无效");
  }
  return status;
}

export function assertCapabilityBudgetPersistenceRejection(error) {
  if (
    error?.code !== "23514" ||
    error?.constraint !== capabilityBudgetConstraint
  ) {
    const failure = new Error(
      "第 018 号持久预算约束未按预期拒绝旧服务可执行计划",
    );
    failure.cause = error;
    throw failure;
  }
  return {
    verified: true,
    errorCode: error.code,
    constraint: error.constraint,
  };
}

export function verifyServiceRollbackGuardEvidence(
  state,
  { expectedRejectionCode = null } = {},
) {
  let rejection;
  try {
    assertServiceRollbackState(state);
  } catch (error) {
    rejection = error;
  }
  if (expectedRejectionCode) {
    if (rejection?.code !== expectedRejectionCode) {
      const failure = new Error(
        `服务回退状态门禁未按预期拒绝目标：${expectedRejectionCode}`,
      );
      failure.cause = rejection;
      throw failure;
    }
    return {
      verified: true,
      rollbackAllowed: false,
      errorCode: rejection.code,
    };
  }
  if (rejection) throw rejection;
  return {
    verified: true,
    rollbackAllowed: true,
    errorCode: null,
  };
}

export function rollbackOutcome(rollbackAllowed) {
  return rollbackAllowed ? "allowed" : "blocked_as_designed";
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
}

export function assertRollbackBaselineObject({ root, commit, runner = run }) {
  runner("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root });
}

async function verifyCapabilityBudgetPersistence(pool) {
  const client = await pool.connect();
  let rejection;
  try {
    await client.query("BEGIN");
    try {
      const probe = `rollback-probe-${randomUUID()}`;
      await client.query(
        `INSERT INTO work_plans(
           id, tenant_id, project_id, requester_key, requester_ciphertext,
           objective_ciphertext, plan_ciphertext, plan_hash, max_level,
           policy_decision, status
         ) VALUES (
           $1, $1, 'rollback-probe', 'rollback-probe', 'rollback-probe',
           'rollback-probe', 'rollback-probe', $1, 'L1', 'ALLOW', 'ready'
         )`,
        [probe],
      );
    } catch (error) {
      rejection = error;
    }
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  return assertCapabilityBudgetPersistenceRejection(rejection);
}

async function runBaselineServiceTests({
  projectRoot,
  databaseUrl,
  manifest,
  runner,
}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ai-employee-rollback-"));
  try {
    const archive = runner(
      "git",
      ["archive", "--format=tar", manifest.commit],
      { cwd: projectRoot, encoding: null },
    );
    runner("tar", ["-xf", "-", "-C", temporaryRoot], {
      input: archive,
      encoding: null,
    });
    await symlink(join(projectRoot, "node_modules"), join(temporaryRoot, "node_modules"));
    runner(
      process.execPath,
      ["--test", join(temporaryRoot, manifest.testFile)],
      {
        cwd: temporaryRoot,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? "C.UTF-8",
          TEST_DATABASE_URL: databaseUrl,
          TEST_DATABASE_TEMP: "false",
        },
        stdio: "inherit",
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function throwLifecycleErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 0) return;
  if (primaryError && cleanupErrors.length === 0) throw primaryError;
  if (!primaryError && cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    primaryError
      ? "回退演练失败且临时数据库清理也失败"
      : "临时数据库清理失败",
  );
}

export async function withTemporaryRollbackDatabase({
  databaseUrl,
  operation,
  createPool = createPostgresPool,
  databaseName =
    `ai_employee_rollback_test_${randomUUID().replaceAll("-", "")}`,
}) {
  const safeDatabaseUrl = validateRollbackTestUrl(databaseUrl);
  if (!/^ai_employee_rollback_test_[0-9a-f]{32}$/u.test(databaseName)) {
    throw new Error("回退演练临时数据库名称无效");
  }
  if (typeof operation !== "function") {
    throw new Error("回退演练临时数据库操作无效");
  }

  const adminPool = createPool({
    databaseUrl: safeDatabaseUrl,
    databasePoolMax: 2,
    databaseSsl: false,
  });
  let databaseCreated = false;
  let pool;
  let result;
  let primaryError;
  try {
    try {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    } catch (error) {
      if (error.code !== "42501") throw error;
      const failure = new Error(
        "回退演练测试账号必须具备创建临时数据库的权限",
      );
      failure.cause = error;
      throw failure;
    }
    databaseCreated = true;
    const scopedUrl = new URL(safeDatabaseUrl);
    scopedUrl.pathname = `/${databaseName}`;
    pool = createPool({
      databaseUrl: scopedUrl.toString(),
      databasePoolMax: 2,
      databaseSsl: false,
    });
    result = await operation({
      pool,
      databaseUrl: scopedUrl.toString(),
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (pool) {
    try {
      await pool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (databaseCreated) {
    try {
      await adminPool.query(
        `DROP DATABASE IF EXISTS "${databaseName}"`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await adminPool.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwLifecycleErrors(primaryError, cleanupErrors);
  return result;
}

export async function verifyRollbackCompatibility({
  root = defaultRoot,
  databaseUrl = process.env.TEST_DATABASE_URL,
  runner = run,
} = {}) {
  const projectRoot = resolve(root);
  const safeDatabaseUrl = validateRollbackTestUrl(databaseUrl);
  const manifest = validateRollbackManifest(
    JSON.parse(await readFile(join(projectRoot, "deploy", "回退基线.json"), "utf8")),
  );

  assertRollbackBaselineObject({
    root: projectRoot,
    commit: manifest.commit,
    runner,
  });
  const baselineMigrationFiles = listForwardMigrationFiles(runner(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", manifest.commit, "db/migrations"],
    { cwd: projectRoot },
  ));
  if (baselineMigrationFiles.length !== manifest.expectedMigrations) {
    throw new Error("回退基线迁移数量与清单不一致");
  }

  let postGuardBaselineMigrationFiles = [];
  if (manifest.postGuardBaseline) {
    assertRollbackBaselineObject({
      root: projectRoot,
      commit: manifest.postGuardBaseline.commit,
      runner,
    });
    postGuardBaselineMigrationFiles = listForwardMigrationFiles(runner(
      "git",
      [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        manifest.postGuardBaseline.commit,
        "db/migrations",
      ],
      { cwd: projectRoot },
    ));
    assertPostGuardBaseline({
      baselineMigrationFiles: postGuardBaselineMigrationFiles,
      expectedMigrations: manifest.postGuardBaseline.expectedMigrations,
    });
  }

  const migrationsDirectory = join(projectRoot, "db", "migrations");
  const migrations = await listExpectedMigrations({ migrationsDirectory });
  const compatibilityPolicy = JSON.parse(await readFile(
    join(migrationsDirectory, "兼容性策略.json"),
    "utf8",
  ));
  const historicalMigrations = manifest.postGuardBaseline
    ? migrations.slice(0, manifest.postGuardBaseline.expectedMigrations)
    : migrations;
  const verificationPlan = buildRollbackVerificationPlan({
    migrations: historicalMigrations,
    baselineMigrationFiles,
    compatibilityPolicy,
  });

  const postGuardVerificationPlan = manifest.postGuardBaseline
    ? buildRollbackVerificationPlan({
      migrations,
      baselineMigrationFiles: postGuardBaselineMigrationFiles,
      compatibilityPolicy,
    })
    : null;

  const verification = await withTemporaryRollbackDatabase({
    databaseUrl: safeDatabaseUrl,
    async operation({ pool, databaseUrl: scopedDatabaseUrl }) {
      const legacyApplied = await migrate(pool, {
        migrationLoader: async () => verificationPlan.legacyTestMigrations,
      });
      const fullLegacyStatus = await inspectMigrationStatus(pool, {
        migrationsDirectory,
      });
      const historicalVersions = new Set(
        historicalMigrations.map((migration) => migration.version),
      );
      const legacyStatus = {
        ...fullLegacyStatus,
        pending: fullLegacyStatus.pending.filter((version) =>
          historicalVersions.has(version)
        ),
      };
      assertMigrationStatus(legacyStatus, { allowPending: true });
      assertLegacyCompatibilityBoundary(legacyStatus, verificationPlan);
      await runBaselineServiceTests({
        projectRoot,
        databaseUrl: scopedDatabaseUrl,
        manifest,
        runner,
      });
      const baselineServiceTestRuns = [{
        passed: true,
        throughMigration: verificationPlan.legacyTestMigrations.at(-1)?.version,
        schemaMigrations: verificationPlan.legacyTestMigrations.length,
        reason: "ordinary_backward_compatibility",
      }];

      const guardedApplied = [];
      let capabilityBudgetPersistence = {
        verified: false,
        required: false,
      };
      const serviceRollbackGuards = [];
      for (const guardedMigration of verificationPlan.guardedMigrations) {
        const migrationIndex = historicalMigrations.findIndex(
          (migration) => migration.version === guardedMigration.version,
        );
        const applied = await migrate(pool, {
          migrationLoader: async () => historicalMigrations.slice(0, migrationIndex + 1),
        });
        guardedApplied.push(...applied);
        if (guardedMigration.guard === capabilityBudgetGuard) {
          capabilityBudgetPersistence = {
            required: true,
            ...await verifyCapabilityBudgetPersistence(pool),
          };
        }
        const rollbackState = await inspectServiceRollbackState(pool, {
          targetSupportsContinuation:
            verificationPlan.targetSupportsContinuation,
          targetSupportsCapabilityBudget:
            verificationPlan.targetSupportsCapabilityBudget,
        });
        const expectedRejectionCode =
          guardedMigration.guard === capabilityBudgetGuard &&
          !verificationPlan.targetSupportsCapabilityBudget
            ? capabilityBudgetRejectionCode
            : null;
        const guardEvidence = {
          version: guardedMigration.version,
          guard: guardedMigration.guard,
          ...verifyServiceRollbackGuardEvidence(rollbackState, {
            expectedRejectionCode,
          }),
        };
        serviceRollbackGuards.push(guardEvidence);
        if (guardEvidence.rollbackAllowed) {
          await runBaselineServiceTests({
            projectRoot,
            databaseUrl: scopedDatabaseUrl,
            manifest,
            runner,
          });
          baselineServiceTestRuns.push({
            passed: true,
            throughMigration: guardedMigration.version,
            schemaMigrations: migrationIndex + 1,
            reason: "state_guard_allowed",
          });
        }
      }
      if (
        verificationPlan.requiresCapabilityBudgetPersistenceProbe &&
        !capabilityBudgetPersistence.verified
      ) {
        capabilityBudgetPersistence = {
          required: true,
          ...await verifyCapabilityBudgetPersistence(pool),
        };
      }
      const fullStatus = await inspectMigrationStatus(pool, { migrationsDirectory });
      const status = {
        ...fullStatus,
        pending: fullStatus.pending.filter((version) => historicalVersions.has(version)),
      };
      assertMigrationStatus(status);
      return {
        baselineServiceTestRuns,
        capabilityBudgetPersistence,
        currentMigrationCount: status.applied,
        guardedApplied,
        legacyApplied,
        serviceRollbackGuards,
      };
    },
  });

  let postGuardVerification = null;
  if (manifest.postGuardBaseline) {
    postGuardVerification = await withTemporaryRollbackDatabase({
      databaseUrl: safeDatabaseUrl,
      async operation({ pool, databaseUrl: scopedDatabaseUrl }) {
        const applied = await migrate(pool, {
          migrationLoader: async () => postGuardVerificationPlan.legacyTestMigrations,
        });
        const status = await inspectMigrationStatus(pool, { migrationsDirectory });
        assertMigrationStatus(status);
        assertLegacyCompatibilityBoundary(status, postGuardVerificationPlan);
        await runBaselineServiceTests({
          projectRoot,
          databaseUrl: scopedDatabaseUrl,
          manifest: manifest.postGuardBaseline,
          runner,
        });
        return {
          applied,
          currentMigrationCount: status.applied,
          baselineServiceTestRun: {
            passed: true,
            throughMigration: migrations.at(-1)?.version,
            schemaMigrations: status.applied,
            reason: "post_guard_backward_compatibility",
          },
        };
      },
    });
  }

  const rollbackAllowed = verification.serviceRollbackGuards.every(
    (guard) => guard.rollbackAllowed,
  );
  return {
    valid: true,
    baselineCommit: manifest.commit,
    baselineMigrations: manifest.expectedMigrations,
    currentMigrationsApplied: postGuardVerification?.applied.length ??
      verification.legacyApplied.length + verification.guardedApplied.length,
    currentMigrationCount: postGuardVerification?.currentMigrationCount ??
      verification.currentMigrationCount,
    legacyServiceTests: {
      passed: true,
      schemaMigrations: verificationPlan.legacyTestMigrations.length,
    },
    baselineServiceTestRuns: postGuardVerification
      ? [
        ...verification.baselineServiceTestRuns,
        postGuardVerification.baselineServiceTestRun,
      ]
      : verification.baselineServiceTestRuns,
    guardedMigrations: verificationPlan.guardedMigrations,
    capabilityBudgetPersistence: verification.capabilityBudgetPersistence,
    serviceRollbackGuards: verification.serviceRollbackGuards,
    rollbackAllowed,
    rollbackOutcome: rollbackOutcome(rollbackAllowed),
    testFile: manifest.testFile,
    productionWrite: false,
  };
}

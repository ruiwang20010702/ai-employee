import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.mjs";
import {
  assertMigrationStatus,
  inspectMigrationStatus,
} from "./migration-status.mjs";
import { createPostgresPool } from "./postgres.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaVersion = "ai-employee-rollback-baseline/v1";

export function validateRollbackTestUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("TEST_DATABASE_URL 必须是合法的本机 PostgreSQL 测试库地址");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("回退演练只支持 PostgreSQL 测试库");
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
  if (!/^[0-9a-f]{40}$/u.test(String(value.commit ?? ""))) {
    throw new Error("回退基线提交必须是完整 SHA");
  }
  if (!Number.isSafeInteger(value.expectedMigrations) || value.expectedMigrations < 1) {
    throw new Error("回退基线迁移数量无效");
  }
  if (value.testFile !== "test/postgres-store.integration.test.mjs") {
    throw new Error("回退基线测试入口不受支持");
  }
  if (!String(value.reason ?? "").trim()) {
    throw new Error("回退基线必须说明选择原因");
  }
  return value;
}

export function countForwardMigrationFiles(output) {
  return String(output)
    .split("\0")
    .filter((file) => file.endsWith(".sql") && !file.endsWith(".undo.sql"))
    .length;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
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

  runner("git", ["merge-base", "--is-ancestor", manifest.commit, "HEAD"], {
    cwd: projectRoot,
  });
  const migrationCount = countForwardMigrationFiles(runner(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", manifest.commit, "db/migrations"],
    { cwd: projectRoot },
  ));
  if (migrationCount !== manifest.expectedMigrations) {
    throw new Error("回退基线迁移数量与清单不一致");
  }

  const pool = createPostgresPool({
    databaseUrl: safeDatabaseUrl,
    databasePoolMax: 2,
    databaseSsl: false,
  });
  let applied;
  let currentMigrationCount;
  try {
    applied = await migrate(pool);
    const status = await inspectMigrationStatus(pool);
    assertMigrationStatus(status);
    currentMigrationCount = status.applied;
  } finally {
    await pool.end();
  }

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
          TEST_DATABASE_URL: safeDatabaseUrl,
          TEST_DATABASE_TEMP: "false",
        },
        stdio: "inherit",
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    valid: true,
    baselineCommit: manifest.commit,
    baselineMigrations: manifest.expectedMigrations,
    currentMigrationsApplied: applied.length,
    currentMigrationCount,
    testFile: manifest.testFile,
    productionWrite: false,
  };
}

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { migrate } from "../src/migrate.mjs";
import { createPostgresPool } from "../src/postgres.mjs";

const { Client } = pg;
const execFileAsync = promisify(execFile);
await applyProductionConfigFile();
const sourceUrl = new URL(process.env.DATABASE_URL);
const maintenanceUrl = new URL(sourceUrl);
maintenanceUrl.pathname = "/postgres";
const databaseName = `ai_employee_restore_drill_${Date.now()}_${randomBytes(3).toString("hex")}`;
if (!/^ai_employee_restore_drill_[a-z0-9_]+$/u.test(databaseName)) {
  throw new Error("Unsafe drill database name");
}
const quotedDatabase = `"${databaseName}"`;
const databaseOwner = decodeURIComponent(sourceUrl.username);
const quotedOwner = `"${databaseOwner.replaceAll('"', '""')}"`;

async function localPeerSql(sql) {
  if (!["127.0.0.1", "::1", "localhost"].includes(sourceUrl.hostname)) {
    throw new Error("Local peer fallback is only allowed for a loopback database");
  }
  const restorePath = process.env.PG_RESTORE_PATH ?? "pg_restore";
  const psqlPath = restorePath.includes("/")
    ? join(dirname(restorePath), "psql")
    : "psql";
  await execFileAsync(psqlPath, [
    "--port", sourceUrl.port || "5432",
    "--dbname", "postgres",
    "--set", "ON_ERROR_STOP=1",
    "--command", sql,
  ]);
}

async function newestBackup() {
  const directory = resolve(process.env.AI_EMPLOYEE_BACKUP_DIRECTORY ?? ".runtime/backups");
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".dump.enc"));
  if (candidates.length === 0) throw new Error("No encrypted backup found");
  const withTimes = await Promise.all(
    candidates.map(async (entry) => ({
      path: join(directory, entry.name),
      mtimeMs: (await stat(join(directory, entry.name))).mtimeMs,
    })),
  );
  return withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].path;
}

function runRestore(backupPath, targetUrl) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./恢复数据库.mjs", import.meta.url)),
      backupPath,
    ], {
      env: {
        ...process.env,
        AI_EMPLOYEE_CONFIG_FILE: "",
        AI_EMPLOYEE_CONFIRM_RESTORE: "yes",
        DATABASE_URL: targetUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && stdout.includes('"restored":true')) accept();
      else reject(new Error(`Isolated restore failed (${code}): ${stderr.trim()}`));
    });
  });
}

const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
let created = false;
let createMode = "database-account";
await maintenance.connect();
try {
  try {
    await maintenance.query(`CREATE DATABASE ${quotedDatabase}`);
  } catch (error) {
    if (error.code !== "42501") throw error;
    await localPeerSql(`CREATE DATABASE ${quotedDatabase} OWNER ${quotedOwner}`);
    createMode = "local-peer-admin";
  }
  created = true;
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  await runRestore(process.argv[2] ? resolve(process.argv[2]) : await newestBackup(), targetUrl.toString());

  const migrationPool = createPostgresPool({
    databaseUrl: targetUrl.toString(),
    databaseSsl: process.env.DATABASE_SSL === "true",
    databasePoolMax: 2,
  });
  let appliedMigrations;
  try {
    appliedMigrations = await migrate(migrationPool);
  } finally {
    await migrationPool.end();
  }

  const restored = new Client({ connectionString: targetUrl.toString() });
  await restored.connect();
  let evidence;
  try {
    const result = await restored.query(`
      SELECT
        (SELECT COUNT(*)::int FROM schema_migrations) AS migrations,
        (SELECT COUNT(*)::int FROM tasks) AS tasks,
        (SELECT COUNT(*)::int FROM memory_items) AS memories,
        (SELECT COUNT(*)::int FROM work_plans) AS work_plans
    `);
    evidence = result.rows[0];
    if (evidence.migrations < 1) throw new Error("Restored database has no migrations");
  } finally {
    await restored.end();
  }
  console.log(JSON.stringify({
    restored: true,
    isolated: true,
    createMode,
    appliedMigrations: appliedMigrations.length,
    evidence,
  }));
} finally {
  if (created) {
    if (createMode === "local-peer-admin") {
      await localPeerSql(`DROP DATABASE ${quotedDatabase} WITH (FORCE)`);
    } else {
      await maintenance.query(`DROP DATABASE ${quotedDatabase} WITH (FORCE)`);
    }
  }
  await maintenance.end();
}

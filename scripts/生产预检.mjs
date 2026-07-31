import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { createPostgresPool, checkPostgres } from "../src/postgres.mjs";
import { migrate } from "../src/migrate.mjs";

const execFileAsync = promisify(execFile);

function validateBase64Key(name, value) {
  if (!value) throw new Error(`${name} is required`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be a canonical base64 encoded 32-byte key`);
  }
}

async function requireExecutable(name, path) {
  const check =
    path.includes("/")
      ? access(path, constants.X_OK)
      : execFileAsync("/usr/bin/which", [path]);
  await check.catch(() => {
    throw new Error(`${name} is not executable: ${path}`);
  });
}

await applyProductionConfigFile();
const config = loadConfig({ production: true });
validateBase64Key("AI_EMPLOYEE_DATA_KEY", config.dataKey);
validateBase64Key(
  "AI_EMPLOYEE_BACKUP_KEY",
  process.env.AI_EMPLOYEE_BACKUP_KEY,
);
if (config.dataKey === process.env.AI_EMPLOYEE_BACKUP_KEY) {
  throw new Error("Data and backup encryption keys must be different");
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
await Promise.all([
  requireExecutable("DWS", config.dwsPath),
  requireExecutable("Codex", config.codexPath),
  requireExecutable("pg_dump", process.env.PG_DUMP_PATH ?? "pg_dump"),
  requireExecutable("pg_restore", process.env.PG_RESTORE_PATH ?? "pg_restore"),
]);

const pool = createPostgresPool(config);
try {
  const databaseCheck = await checkPostgres(pool);
  const applied = await migrate(pool);
  console.log(
    JSON.stringify(
      {
        ready: true,
        database: databaseCheck.database,
        appliedMigrations: applied,
        targets: config.targetUserIds.length,
        capabilities: [...config.capabilities],
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}

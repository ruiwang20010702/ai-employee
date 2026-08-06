import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultMigrationsDirectory = fileURLToPath(
  new URL("../db/migrations/", import.meta.url),
);

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function listExpectedMigrations({
  migrationsDirectory = defaultMigrationsDirectory,
} = {}) {
  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name) && !name.endsWith(".undo.sql"))
    .sort();
  return Promise.all(
    filenames.map(async (version) => {
      const content = await readFile(resolve(migrationsDirectory, version), "utf8");
      return { version, content, checksum: checksum(content) };
    }),
  );
}

export async function inspectMigrationStatus(pool, options = {}) {
  const expected = await listExpectedMigrations(options);
  const table = await pool.query(
    "SELECT to_regclass('public.schema_migrations') AS table_name",
  );
  const tablePresent = Boolean(table.rows[0]?.table_name);
  const appliedRows = tablePresent
    ? (await pool.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    )).rows
    : [];
  const expectedByVersion = new Map(
    expected.map((migration) => [migration.version, migration.checksum]),
  );
  const appliedByVersion = new Map(
    appliedRows.map((migration) => [migration.version, migration.checksum]),
  );
  const pending = expected
    .filter((migration) => !appliedByVersion.has(migration.version))
    .map((migration) => migration.version);
  const checksumMismatches = expected
    .filter((migration) =>
      appliedByVersion.has(migration.version) &&
      appliedByVersion.get(migration.version) !== migration.checksum)
    .map((migration) => migration.version);
  const unexpected = appliedRows
    .filter((migration) => !expectedByVersion.has(migration.version))
    .map((migration) => migration.version);
  return {
    current: tablePresent && pending.length === 0 && checksumMismatches.length === 0,
    tablePresent,
    expected: expected.length,
    applied: appliedRows.length,
    pending,
    checksumMismatches,
    unexpected,
  };
}

export function assertMigrationStatus(status, { allowPending = false } = {}) {
  if (status.checksumMismatches.length > 0) {
    const error = new Error(
      `Database migration checksum mismatch: ${status.checksumMismatches.join(", ")}`,
    );
    error.code = "database_migration_checksum_mismatch";
    error.migrations = status.checksumMismatches;
    throw error;
  }
  if (allowPending) return;
  if (!status.tablePresent) {
    const error = new Error("Database schema is not initialized; run npm run db:migrate");
    error.code = "database_schema_not_initialized";
    error.migrations = status.pending;
    throw error;
  }
  if (status.pending.length > 0) {
    const error = new Error(
      `Database schema is outdated; pending migrations: ${status.pending.join(", ")}; run npm run db:migrate`,
    );
    error.code = "database_migrations_pending";
    error.migrations = status.pending;
    throw error;
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultMigrationsDirectory = fileURLToPath(
  new URL("../db/migrations/", import.meta.url),
);
const compatibilityPolicyFilename = "兼容性策略.json";

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

function migrationNumber(version) {
  const value = Number.parseInt(String(version).match(/^(\d+)_/u)?.[1] ?? "", 10);
  return Number.isSafeInteger(value) ? value : null;
}

export function validateMigrationCompatibility(migrations, policy) {
  if (policy?.schema !== "ai-employee-migration-compatibility/v1") {
    throw new Error("Migration compatibility policy schema is invalid");
  }
  if (!Number.isSafeInteger(policy.policyStartsAt) || policy.policyStartsAt < 1) {
    throw new Error("Migration compatibility policy start version is invalid");
  }
  if (!policy.migrations || Array.isArray(policy.migrations)) {
    throw new Error("Migration compatibility policy entries are invalid");
  }
  for (const migration of migrations) {
    const number = migrationNumber(migration.version);
    if (number == null || number < policy.policyStartsAt) continue;
    const entry = policy.migrations[migration.version];
    if (
      entry?.backwardCompatible !== true ||
      entry?.rollback !== "service_only" ||
      !String(entry?.evidence ?? "").trim()
    ) {
      throw new Error(
        `Migration compatibility evidence is missing: ${migration.version}`,
      );
    }
    const withoutForeignKeyDeleteActions = migration.content.replace(
      /ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION)/giu,
      "",
    );
    if (
      /\b(?:DROP|TRUNCATE|RENAME|ALTER\s+COLUMN|DELETE\s+FROM)\b/iu.test(
        withoutForeignKeyDeleteActions,
      )
    ) {
      throw new Error(
        `Backward-compatible migration contains a destructive statement: ${migration.version}`,
      );
    }
    for (const addColumn of migration.content.matchAll(
      /ADD\s+COLUMN\s+[^,;]+/giu,
    )) {
      if (/NOT\s+NULL/iu.test(addColumn[0]) && !/DEFAULT/iu.test(addColumn[0])) {
        throw new Error(
          `Backward-compatible migration adds a required column without a default: ${migration.version}`,
        );
      }
    }
  }
}

export async function listExpectedMigrations({
  migrationsDirectory = defaultMigrationsDirectory,
} = {}) {
  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name) && !name.endsWith(".undo.sql"))
    .sort();
  const migrations = await Promise.all(
    filenames.map(async (version) => {
      const content = await readFile(resolve(migrationsDirectory, version), "utf8");
      return { version, content, checksum: checksum(content) };
    }),
  );
  const policy = JSON.parse(
    await readFile(resolve(migrationsDirectory, compatibilityPolicyFilename), "utf8"),
  );
  validateMigrationCompatibility(migrations, policy);
  return migrations;
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

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultMigrationsDirectory = fileURLToPath(
  new URL("../db/migrations/", import.meta.url),
);
const compatibilityPolicyFilename = "兼容性策略.json";
const legacyTaskStatuses = Object.freeze([
  "queued",
  "processing",
  "awaiting_approval",
  "no_reply",
  "approved",
  "rejected",
  "sending",
  "completed",
  "send_unknown",
  "cancelled_manual",
  "cancelled_operator",
  "expired",
  "dead",
]);

function removeCompatibleTaskStatusConstraintReplacement(content) {
  const dropPattern = /ALTER\s+TABLE\s+tasks\s+DROP\s+CONSTRAINT\s+tasks_status_check\s*;/giu;
  const drops = [...content.matchAll(dropPattern)];
  if (drops.length === 0) return content;
  if (drops.length !== 1) return content;
  const replacement = content.match(
    /ALTER\s+TABLE\s+tasks\s+ADD\s+CONSTRAINT\s+tasks_status_check\s+CHECK\s*\(([\s\S]*?)\)\s*;/iu,
  );
  if (!replacement) return content;
  const expression = replacement[1].trim();
  const statusList = expression.match(/^status\s+IN\s*\(([\s\S]*)\)$/iu);
  if (!statusList) return content;
  const residue = statusList[1]
    .replace(/'[^']*'/gu, "")
    .replace(/[\s,]/gu, "");
  if (residue !== "") return content;
  const statuses = new Set(
    [...statusList[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]),
  );
  if (!legacyTaskStatuses.every((status) => statuses.has(status))) {
    return content;
  }
  return content.replace(dropPattern, "");
}

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
    const supportedStateGuards = new Set([
      "waiting_information_states_absent",
      "capability_budget_target_support_required",
    ]);
    const rollbackIsSupported = entry?.rollback === "service_only" ||
      (
        entry?.rollback === "service_only_with_state_guard" &&
        supportedStateGuards.has(entry?.guard)
      );
    if (
      entry?.backwardCompatible !== true ||
      !rollbackIsSupported ||
      !String(entry?.evidence ?? "").trim()
    ) {
      throw new Error(
        `Migration compatibility evidence is missing: ${migration.version}`,
      );
    }
    const withoutCompatibleConstraintReplacement =
      removeCompatibleTaskStatusConstraintReplacement(migration.content);
    const withoutForeignKeyDeleteActions = withoutCompatibleConstraintReplacement.replace(
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

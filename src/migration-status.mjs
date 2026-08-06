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
    filenames.map(async (version) => ({
      version,
      checksum: checksum(await readFile(resolve(migrationsDirectory, version), "utf8")),
    })),
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
  const expectedByVersion = new Map(expected.map((item) => [item.version, item.checksum]));
  const appliedByVersion = new Map(appliedRows.map((item) => [item.version, item.checksum]));
  const pending = expected.filter((item) => !appliedByVersion.has(item.version)).map((item) => item.version);
  const checksumMismatches = expected
    .filter((item) => appliedByVersion.has(item.version) && appliedByVersion.get(item.version) !== item.checksum)
    .map((item) => item.version);
  const unexpected = appliedRows
    .filter((item) => !expectedByVersion.has(item.version))
    .map((item) => item.version);
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
    throw new Error(`Database migration checksum mismatch: ${status.checksumMismatches.join(", ")}`);
  }
  if (status.unexpected.length > 0) {
    throw new Error(`Database contains migrations newer than this release: ${status.unexpected.join(", ")}`);
  }
  if (!allowPending && status.pending.length > 0) {
    throw new Error(`Database schema is outdated: ${status.pending.join(", ")}`);
  }
}

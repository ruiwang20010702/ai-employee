import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { createPostgresPool } from "./postgres.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";

const migrationsDirectory = fileURLToPath(
  new URL("../db/migrations/", import.meta.url),
);

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('ai-employee-schema-migrations'))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const filenames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_.+\.sql$/u.test(name) && !name.endsWith(".undo.sql"))
      .sort();
    const applied = [];
    for (const filename of filenames) {
      const content = await readFile(resolve(migrationsDirectory, filename), "utf8");
      const digest = checksum(content);
      const existing = await client.query(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [filename],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].checksum !== digest) {
          throw new Error(`Migration checksum mismatch: ${filename}`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(content);
        await client.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
          [filename, digest],
        );
        await client.query("COMMIT");
        applied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client
      .query(
        "SELECT pg_advisory_unlock(hashtext('ai-employee-schema-migrations'))",
      )
      .catch(() => {});
    client.release();
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.env.AI_EMPLOYEE_CONFIG_FILE) {
    await applyProductionConfigFile();
  }
  const config = loadConfig({ requireTargets: false, production: true });
  const pool = createPostgresPool(config);
  try {
    const applied = await migrate(pool);
    console.log(JSON.stringify({ applied }, null, 2));
  } finally {
    await pool.end();
  }
}

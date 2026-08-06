import { loadConfig } from "./config.mjs";
import { listExpectedMigrations } from "./migration-status.mjs";
import { createPostgresPool } from "./postgres.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { isMainModule } from "./main-module.mjs";

export async function migrate(pool, {
  migrationLoader = listExpectedMigrations,
} = {}) {
  const migrations = await migrationLoader();
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
    const applied = [];
    for (const { version: filename, content, checksum: digest } of migrations) {
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

const isMain = isMainModule(import.meta.url);

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

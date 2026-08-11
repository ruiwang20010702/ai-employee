import { applyProductionConfigFile } from "../src/production-config-file.mjs";
import { loadConfig } from "../src/config.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { assertForwardMaintenanceState } from "../src/forward-maintenance.mjs";

if (!process.env.AI_EMPLOYEE_CONFIG_FILE) {
  throw new Error("AI_EMPLOYEE_CONFIG_FILE is required");
}
await applyProductionConfigFile();
const config = loadConfig({ requireTargets: false, production: true });
const pool = createPostgresPool({
  databaseUrl: config.databaseUrl,
  databaseSsl: config.databaseSsl,
  databasePoolMax: 2,
});

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const [pause, tasks, workPlans, pendingMessages, expiredLeases, migrations] =
      await Promise.all([
        client.query(
          "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'paused'",
          [config.tenantId],
        ),
        client.query(
          `SELECT status, COUNT(*)::int AS count
           FROM tasks
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL
           GROUP BY status`,
          [config.tenantId],
        ),
        client.query(
          `SELECT status, COUNT(*)::int AS count
           FROM work_plans
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL
           GROUP BY status`,
          [config.tenantId],
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM messages
           WHERE tenant_id = $1 AND status = 'pending'`,
          [config.tenantId],
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM work_plans
           WHERE tenant_id = $1 AND privacy_erased_at IS NULL
             AND status IN ('executing','verifying')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW()`,
          [config.tenantId],
        ),
        client.query("SELECT version FROM schema_migrations ORDER BY version"),
      ]);
    const evidence = assertForwardMaintenanceState({
      paused: pause.rows[0]?.value === "true",
      tasks: Object.fromEntries(
        tasks.rows.map((row) => [row.status, Number(row.count)]),
      ),
      workPlans: Object.fromEntries(
        workPlans.rows.map((row) => [row.status, Number(row.count)]),
      ),
      pendingMessages: Number(pendingMessages.rows[0]?.count ?? 0),
      expiredExecutionLeases: Number(expiredLeases.rows[0]?.count ?? 0),
    });
    await client.query("COMMIT");
    console.log(JSON.stringify({
      safe: true,
      paused: evidence.paused,
      activeTasks: evidence.activeTasks,
      activePlans: evidence.activePlans,
      pendingMessages: evidence.pendingMessages,
      expiredExecutionLeases: evidence.expiredExecutionLeases,
      migrationCount: migrations.rowCount,
      latestMigration: migrations.rows.at(-1)?.version ?? null,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

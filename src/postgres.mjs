import pg from "pg";

const { Pool } = pg;

export function createPostgresPool(config) {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "ai-employee",
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  });
}

export async function checkPostgres(pool) {
  const result = await pool.query(
    "SELECT current_database() AS database, now() AS checked_at",
  );
  return result.rows[0];
}

import pg from "pg";

const { Pool } = pg;

export function postgresPoolOptions(config, { readOnly = false } = {}) {
  if (!config.databaseUrl) throw new Error("FOURSDAY_DATABASE_URL is required");
  return {
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: readOnly ? "foursday-read-only" : "foursday",
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
  };
}

export function createPostgresPool(config, options = {}) {
  return new Pool(postgresPoolOptions(config, options));
}

export async function checkPostgres(pool) {
  const result = await pool.query(
    "SELECT current_database() AS database, now() AS checked_at",
  );
  return result.rows[0];
}

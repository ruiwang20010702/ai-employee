import assert from "node:assert/strict";
import { test } from "node:test";
import { DataCipher } from "../src/crypto.mjs";
import { listExpectedMigrations } from "../src/migration-status.mjs";
import { PostgresStore } from "../src/postgres-store.mjs";
import { postgresPoolOptions } from "../src/postgres.mjs";

test("PostgreSQL 只读连接由数据库会话强制拒绝写入", () => {
  const options = postgresPoolOptions({
    databaseUrl: "postgresql://employee:secret@127.0.0.1/employee",
    databasePoolMax: 2,
    databaseSsl: false,
  }, { readOnly: true });
  assert.equal(options.application_name, "foursday-read-only");
  assert.equal(options.options, "-c default_transaction_read_only=on");
});

test("PostgreSQL 只读打开校验迁移和哨兵且不执行写语句", async () => {
  const dataKey = Buffer.alloc(32, 7).toString("base64");
  const cipher = await DataCipher.create({ encodedKey: dataKey, ephemeral: false });
  const expected = await listExpectedMigrations();
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("current_database")) {
        return { rows: [{ database: "test", checked_at: new Date() }] };
      }
      if (String(sql).includes("to_regclass")) {
        return { rows: [{ table_name: "schema_migrations" }] };
      }
      if (String(sql).includes("SELECT version, checksum")) {
        return {
          rows: expected.map(({ version, checksum }) => ({ version, checksum })),
        };
      }
      if (String(sql).includes("SELECT value FROM settings")) {
        return { rows: [{ value: cipher.encrypt("ai-employee-v1") }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const store = await new PostgresStore({
    tenantId: "tenant_test",
    dataKey,
  }, { pool, readOnly: true }).open();
  assert.equal(store.opened, true);
  assert.equal(
    queries.every((sql) => /^\s*SELECT/iu.test(sql)),
    true,
  );
  await store.close();
});

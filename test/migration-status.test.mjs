import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMigrationStatus,
  inspectMigrationStatus,
  listExpectedMigrations,
  validateMigrationCompatibility,
} from "../src/migration-status.mjs";

test("迁移状态检查只读识别缺失迁移", async () => {
  const expected = await listExpectedMigrations();
  const applied = expected.slice(0, -1);
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: "schema_migrations" }] };
      }
      return {
        rows: applied.map(({ version, checksum }) => ({ version, checksum })),
      };
    },
  };
  const status = await inspectMigrationStatus(pool);
  assert.equal(status.current, false);
  assert.deepEqual(status.pending, [expected.at(-1).version]);
  assert.equal(queries.every((sql) => /^SELECT/iu.test(sql.trim())), true);
  assert.throws(
    () => assertMigrationStatus(status),
    { code: "database_migrations_pending", message: /pending migrations/u },
  );
  assert.doesNotThrow(() =>
    assertMigrationStatus(status, { allowPending: true }));
});

test("迁移状态检查拒绝已应用文件的校验和漂移", async () => {
  const expected = await listExpectedMigrations();
  const pool = {
    async query(sql) {
      if (sql.includes("to_regclass")) {
        return { rows: [{ table_name: "schema_migrations" }] };
      }
      return {
        rows: expected.map(({ version, checksum }, index) => ({
          version,
          checksum: index === 0 ? "0".repeat(64) : checksum,
        })),
      };
    },
  };
  const status = await inspectMigrationStatus(pool);
  assert.deepEqual(status.checksumMismatches, [expected[0].version]);
  assert.throws(
    () => assertMigrationStatus(status, { allowPending: true }),
    {
      code: "database_migration_checksum_mismatch",
      message: /checksum mismatch/u,
    },
  );
});

test("没有迁移表时预检可报告但运行时必须停止", async () => {
  const pool = {
    async query() {
      return { rows: [{ table_name: null }] };
    },
  };
  const status = await inspectMigrationStatus(pool);
  assert.equal(status.tablePresent, false);
  assert.equal(status.pending.length, status.expected);
  assert.doesNotThrow(() =>
    assertMigrationStatus(status, { allowPending: true }));
  assert.throws(
    () => assertMigrationStatus(status),
    { code: "database_schema_not_initialized", message: /not initialized/u },
  );
});

test("新迁移必须登记服务回退证据", () => {
  const migrations = [{
    version: "017_新增字段.sql",
    content: "ALTER TABLE tasks ADD COLUMN new_value TEXT;",
  }];
  assert.throws(
    () => validateMigrationCompatibility(migrations, {
      schema: "ai-employee-migration-compatibility/v1",
      policyStartsAt: 15,
      migrations: {},
    }),
    /evidence is missing/u,
  );
});

test("声明服务可回退的迁移禁止破坏性 SQL", () => {
  const policy = {
    schema: "ai-employee-migration-compatibility/v1",
    policyStartsAt: 15,
    migrations: {
      "017_危险迁移.sql": {
        backwardCompatible: true,
        rollback: "service_only",
        evidence: "测试",
      },
    },
  };
  assert.throws(
    () => validateMigrationCompatibility([{
      version: "017_危险迁移.sql",
      content: "ALTER TABLE tasks DROP COLUMN payload_ciphertext;",
    }], policy),
    /destructive statement/u,
  );
  assert.throws(
    () => validateMigrationCompatibility([{
      version: "017_危险迁移.sql",
      content: "ALTER TABLE tasks ADD COLUMN required_value TEXT NOT NULL;",
    }], policy),
    /without a default/u,
  );
});

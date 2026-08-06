import assert from "node:assert/strict";
import test from "node:test";
import {
  countForwardMigrationFiles,
  validateRollbackManifest,
  validateRollbackTestUrl,
} from "../src/rollback-compatibility.mjs";

test("服务回退演练只允许本机明确命名的测试数据库", () => {
  assert.equal(
    validateRollbackTestUrl("postgresql://postgres:test@localhost:5432/ai_employee_test"),
    "postgresql://postgres:test@localhost:5432/ai_employee_test",
  );
  for (const value of [
    "postgresql://prod.example.com/ai_employee_test",
    "postgresql://localhost/ai_employee",
    "mysql://localhost/ai_employee_test",
  ]) {
    assert.throws(() => validateRollbackTestUrl(value), /回退演练/u);
  }
});

test("服务回退基线使用零分隔文件名统计中文迁移", () => {
  assert.equal(
    countForwardMigrationFiles(
      "db/migrations/001_基础.sql\0db/migrations/001_基础.undo.sql\0" +
        "db/migrations/002_中文.sql\0",
    ),
    2,
  );
});

test("服务回退基线绑定完整提交、迁移数量和固定测试入口", () => {
  const manifest = {
    schemaVersion: "ai-employee-rollback-baseline/v1",
    commit: "a".repeat(40),
    expectedMigrations: 14,
    testFile: "test/postgres-store.integration.test.mjs",
    reason: "迁移前兼容基线",
  };
  assert.equal(validateRollbackManifest(manifest), manifest);
  assert.throws(
    () => validateRollbackManifest({ ...manifest, commit: "abc" }),
    /完整 SHA/u,
  );
  assert.throws(
    () => validateRollbackManifest({ ...manifest, testFile: "test/other.test.mjs" }),
    /不受支持/u,
  );
});

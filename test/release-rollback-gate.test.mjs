import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseRollbackGate } from "../src/release-rollback-gate.mjs";

test("没有待迁移项时允许建立第一个版本化兼容基线", () => {
  assert.deepEqual(
    validateReleaseRollbackGate({
      preflight: { ready: true, migrations: { pending: [] } },
      previousRelease: "",
    }),
    {
      valid: true,
      pendingMigrations: 0,
      rollbackTargetReady: false,
      databaseWrite: false,
    },
  );
});

test("存在待迁移项时必须先有可验证上一版本", () => {
  const preflight = {
    ready: true,
    migrations: { pending: ["015_example.sql"] },
  };
  assert.throws(
    () => validateReleaseRollbackGate({ preflight, previousRelease: "" }),
    /没有可验证的上一版本/u,
  );
  assert.equal(
    validateReleaseRollbackGate({
      preflight,
      previousRelease: "/stable/releases/baseline",
    }).rollbackTargetReady,
    true,
  );
});

test("发布回退门禁拒绝不完整或失败的生产预检", () => {
  assert.throws(
    () => validateReleaseRollbackGate({ preflight: { ready: false } }),
    /生产预检未通过/u,
  );
  assert.throws(
    () => validateReleaseRollbackGate({ preflight: { ready: true } }),
    /缺少迁移状态/u,
  );
});

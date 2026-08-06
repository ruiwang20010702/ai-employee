import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate } from "../src/migrate.mjs";

test("迁移兼容性策略失败时不会连接或写入数据库", async () => {
  let connected = false;
  const pool = {
    async connect() {
      connected = true;
      throw new Error("must not connect");
    },
  };
  await assert.rejects(
    () => migrate(pool, {
      migrationLoader: async () => {
        throw new Error("migration policy rejected");
      },
    }),
    /migration policy rejected/u,
  );
  assert.equal(connected, false);
});

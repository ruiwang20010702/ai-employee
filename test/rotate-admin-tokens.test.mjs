import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rotateAdminTokens } from "../scripts/轮换管理令牌.mjs";

test("管理令牌原子轮换且成功后不保留明文快照", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-admin-token-rotate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "production.json");
  const original = {
    DATABASE_URL: "postgres://localhost/test",
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "old-read",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "old-write",
  };
  await writeFile(configPath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const result = await rotateAdminTokens({
    configPath,
    now: new Date("2026-08-05T00:00:00.000Z"),
  });
  const next = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(next.DATABASE_URL, original.DATABASE_URL);
  assert.equal(Buffer.byteLength(next.AI_EMPLOYEE_ADMIN_READ_TOKEN), 64);
  assert.equal(Buffer.byteLength(next.AI_EMPLOYEE_ADMIN_WRITE_TOKEN), 64);
  assert.notEqual(
    next.AI_EMPLOYEE_ADMIN_READ_TOKEN,
    next.AI_EMPLOYEE_ADMIN_WRITE_TOKEN,
  );
  assert.equal((await stat(configPath)).mode & 0o077, 0);
  assert.equal(result.backupPath, null);
  assert.equal(result.rollbackSnapshotRemoved, true);
  await assert.rejects(
    stat(join(
      directory,
      "config-backups",
      "production-2026-08-05T00-00-00-000Z.json",
    )),
    { code: "ENOENT" },
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(next.AI_EMPLOYEE_ADMIN_READ_TOKEN, "u"),
  );
  assert.equal(result.secretsPrinted, false);
});

test("外部托管的管理令牌不能被配置文件轮换覆盖", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-admin-token-external-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "production.json");
  await writeFile(configPath, JSON.stringify({
    AI_EMPLOYEE_ADMIN_READ_TOKEN: "env://ADMIN_READ_SECRET",
    AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "env://ADMIN_WRITE_SECRET",
  }), { mode: 0o600 });
  const previousRead = process.env.ADMIN_READ_SECRET;
  const previousWrite = process.env.ADMIN_WRITE_SECRET;
  process.env.ADMIN_READ_SECRET = "read-secret";
  process.env.ADMIN_WRITE_SECRET = "write-secret";
  try {
    await assert.rejects(
      rotateAdminTokens({ configPath }),
      /must be rotated in their secret store/u,
    );
  } finally {
    if (previousRead == null) delete process.env.ADMIN_READ_SECRET;
    else process.env.ADMIN_READ_SECRET = previousRead;
    if (previousWrite == null) delete process.env.ADMIN_WRITE_SECRET;
    else process.env.ADMIN_WRITE_SECRET = previousWrite;
  }
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  keychainMigrationEntries,
  migrateProductionSecretsToKeychain,
} from "../scripts/迁移生产密钥到钥匙串.mjs";

const sourceValues = Object.freeze({
  DATABASE_URL: "postgresql://private-database",
  AI_EMPLOYEE_DATA_KEY: "private-data-key",
  AI_EMPLOYEE_BACKUP_KEY: "private-backup-key",
  AI_EMPLOYEE_ADMIN_READ_TOKEN: "private-read-token",
  AI_EMPLOYEE_ADMIN_WRITE_TOKEN: "private-write-token",
  AI_EMPLOYEE_ALLOWED_CAPABILITIES: "draft_reply",
});

async function fixture(values = sourceValues, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-keychain-"));
  const configPath = join(directory, "production.json");
  await writeFile(configPath, `${JSON.stringify(values, null, 2)}\n`, { mode });
  await chmod(configPath, mode);
  return { directory, configPath };
}

function memoryKeychain() {
  const entries = new Map();
  return {
    entries,
    writer: async (service, account, value) => {
      entries.set(`${service}/${account}`, value);
    },
    reader: async (service, account) => entries.get(`${service}/${account}`),
    deleter: async (service, account) => entries.delete(`${service}/${account}`),
  };
}

test("默认只预览固定五项密钥且不写入", async () => {
  const { configPath } = await fixture();
  let writes = 0;
  const result = await migrateProductionSecretsToKeychain({
    configPath,
    keychainWriter: async () => { writes += 1; },
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.plannedKeys, keychainMigrationEntries.map(([key]) => key));
  assert.equal(result.configUpdated, false);
  assert.equal(writes, 0);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), sourceValues);
});

test("应用迁移后逐项回读并原子替换为钥匙串引用", async () => {
  const { directory, configPath } = await fixture();
  const keychain = memoryKeychain();
  const result = await migrateProductionSecretsToKeychain({
    configPath,
    apply: true,
    platform: "darwin",
    now: new Date("2026-08-05T08:00:00.000Z"),
    keychainWriter: keychain.writer,
    keychainReader: keychain.reader,
  });

  assert.equal(result.completed, true);
  assert.equal(result.configUpdated, true);
  assert.equal(keychain.entries.size, 5);
  const next = JSON.parse(await readFile(configPath, "utf8"));
  for (const [key, account] of keychainMigrationEntries) {
    assert.equal(next[key], `keychain://ai-employee-production/${account}`);
  }
  assert.equal(next.AI_EMPLOYEE_ALLOWED_CAPABILITIES, "draft_reply");
  assert.equal(result.rollbackSnapshot, null);
  assert.equal(result.rollbackSnapshotRemoved, true);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await assert.rejects(
    stat(join(
      directory,
      "keychain-migration-backups",
      "production-2026-08-05T08-00-00-000Z.json",
    )),
    { code: "ENOENT" },
  );
});

test("任一钥匙串写入或回读失败时保留原配置、不留快照且错误不泄露密钥", async () => {
  const { directory, configPath } = await fixture();
  const keychain = memoryKeychain();
  let error;
  try {
    await migrateProductionSecretsToKeychain({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async (service, account, value) => {
        if (account === "backup-key") throw new Error(value);
        await keychain.writer(service, account, value);
      },
      keychainReader: keychain.reader,
      keychainDeleter: keychain.deleter,
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.match(error.message, /AI_EMPLOYEE_BACKUP_KEY/u);
  for (const secret of Object.values(sourceValues).filter((value) => value.startsWith("private"))) {
    assert.equal(error.message.includes(secret), false);
  }
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), sourceValues);
  assert.equal(keychain.entries.size, 0);
  await assert.rejects(
    stat(join(directory, "keychain-migration-backups")),
    { code: "ENOENT" },
  );
});

test("已迁移配置重复执行只做回读验证", async () => {
  const values = { ...sourceValues };
  const keychain = memoryKeychain();
  for (const [key, account] of keychainMigrationEntries) {
    values[key] = `keychain://ai-employee-production/${account}`;
    await keychain.writer("ai-employee-production", account, `resolved-${account}`);
  }
  const { configPath } = await fixture(values);
  let writes = 0;
  const result = await migrateProductionSecretsToKeychain({
    configPath,
    apply: true,
    platform: "darwin",
    keychainWriter: async () => { writes += 1; },
    keychainReader: keychain.reader,
  });

  assert.equal(result.configUpdated, false);
  assert.equal(result.rollbackSnapshot, null);
  assert.equal(writes, 0);
});

test("拒绝读取权限过宽的生产配置", async () => {
  const { configPath } = await fixture(sourceValues, 0o644);
  await assert.rejects(
    migrateProductionSecretsToKeychain({ configPath }),
    /must not be readable by group or others/u,
  );
});

test("迁移失败且钥匙串清理失败时返回稳定的人工核对提示", async () => {
  const { configPath } = await fixture();
  let firstSecret;
  await assert.rejects(
    migrateProductionSecretsToKeychain({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async (_service, account, value) => {
        firstSecret ??= value;
        if (account === "backup-key") throw new Error(value);
      },
      keychainReader: async () => firstSecret,
      keychainDeleter: async () => { throw new Error(firstSecret); },
    }),
    (error) => (
      error.message === "Keychain write failed and cleanup is incomplete: AI_EMPLOYEE_DATA_KEY" &&
      !error.message.includes(firstSecret)
    ),
  );
});

test("配置提交前崩溃后重试可复用完全匹配的既有钥匙串项", async () => {
  const { configPath } = await fixture();
  const keychain = memoryKeychain();
  for (const [key, account] of keychainMigrationEntries) {
    await keychain.writer("ai-employee-production", account, sourceValues[key]);
  }
  let writes = 0;
  const result = await migrateProductionSecretsToKeychain({
    configPath,
    apply: true,
    platform: "darwin",
    keychainWriter: async () => { writes += 1; },
    keychainReader: keychain.reader,
    keychainDeleter: keychain.deleter,
  });
  assert.equal(writes, 0);
  assert.equal(result.reusedExistingKeys.length, 5);
  assert.equal(result.configUpdated, true);
});

test("迁移目标存在冲突值时在写入配置和钥匙串前停止", async () => {
  const { configPath } = await fixture();
  const keychain = memoryKeychain();
  await keychain.writer("ai-employee-production", "data-key", "different-value");
  let writes = 0;
  await assert.rejects(
    migrateProductionSecretsToKeychain({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async () => { writes += 1; },
      keychainReader: keychain.reader,
      keychainDeleter: keychain.deleter,
    }),
    /already contains another value: AI_EMPLOYEE_DATA_KEY/u,
  );
  assert.equal(writes, 0);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), sourceValues);
});

test("配置提交失败会清理本次新增钥匙串项和临时回滚快照", async () => {
  const now = new Date("2026-08-10T08:00:00.000Z");
  const { directory, configPath } = await fixture();
  const backupDirectory = join(directory, "keychain-migration-backups");
  const collision = join(backupDirectory, "production-2026-08-10T08-00-00-000Z.json");
  await mkdir(backupDirectory, { mode: 0o700 });
  await writeFile(collision, "existing", { mode: 0o600 });
  const keychain = memoryKeychain();
  await assert.rejects(
    migrateProductionSecretsToKeychain({
      configPath,
      apply: true,
      platform: "darwin",
      now,
      keychainWriter: keychain.writer,
      keychainReader: keychain.reader,
      keychainDeleter: keychain.deleter,
    }),
    /failed before configuration commit/u,
  );
  assert.equal(keychain.entries.size, 0);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), sourceValues);
  assert.equal(await readFile(collision, "utf8"), "existing");
});

test("迁移写入后才报错时通过匹配回读清理当前项", async () => {
  const { configPath } = await fixture();
  const keychain = memoryKeychain();
  await assert.rejects(
    migrateProductionSecretsToKeychain({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async (service, account, value) => {
        await keychain.writer(service, account, value);
        throw new Error(value);
      },
      keychainReader: keychain.reader,
      keychainDeleter: keychain.deleter,
    }),
    /Keychain write or readback failed: DATABASE_URL/u,
  );
  assert.equal(keychain.entries.size, 0);
});

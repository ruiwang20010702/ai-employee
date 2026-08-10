import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProductionConfig } from "../scripts/初始化生产配置.mjs";
import { provisionGeneratedKeychainSecrets } from "../scripts/初始化钥匙串密钥.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-keychain-provision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "production.json");
  await initializeProductionConfig({ outputPath: configPath, keychainService: "ai-employee-test" });
  return { configPath };
}

test("钥匙串初始化默认只预览且不产生密钥值", async (t) => {
  const { configPath } = await fixture(t);
  let writes = 0;
  const result = await provisionGeneratedKeychainSecrets({
    configPath,
    keychainWriter: async () => { writes += 1; },
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.completed, false);
  assert.equal(result.service, "ai-employee-test");
  assert.equal(result.plannedKeys.length, 4);
  assert.equal(result.secretsPrinted, false);
  assert.equal(writes, 0);
  assert.doesNotMatch(JSON.stringify(result), /[A-Za-z0-9+/=]{40,}/u);
});

test("显式应用后写入四项独立密钥并逐项回读", async (t) => {
  const { configPath } = await fixture(t);
  const entries = new Map();
  const result = await provisionGeneratedKeychainSecrets({
    configPath,
    apply: true,
    platform: "darwin",
    keychainWriter: async (service, account, secret) => {
      assert.equal(entries.has(`${service}/${account}`), false);
      entries.set(`${service}/${account}`, secret);
    },
    keychainReader: async (service, account) => entries.get(`${service}/${account}`),
  });
  assert.equal(result.completed, true);
  assert.equal(entries.size, 4);
  assert.equal(new Set(entries.values()).size, 4);
  assert.equal(result.secretsPrinted, false);
  assert.equal(JSON.stringify(result).includes([...entries.values()][0]), false);
  const configText = await readFile(configPath, "utf8");
  for (const secret of entries.values()) assert.equal(configText.includes(secret), false);
});

test("中途失败会清理由本次调用创建的钥匙串项", async (t) => {
  const { configPath } = await fixture(t);
  const entries = new Map();
  const deleted = [];
  await assert.rejects(
    provisionGeneratedKeychainSecrets({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async (service, account, secret) => {
        if (account === "backup-key") throw new Error(secret);
        entries.set(`${service}/${account}`, secret);
      },
      keychainReader: async (service, account) => entries.get(`${service}/${account}`),
      keychainDeleter: async (service, account) => {
        deleted.push(`${service}/${account}`);
        entries.delete(`${service}/${account}`);
      },
    }),
    (error) => error.message === "Keychain provisioning failed: AI_EMPLOYEE_BACKUP_KEY",
  );
  assert.deepEqual(deleted, ["ai-employee-test/data-key"]);
  assert.equal(entries.size, 0);
});

test("非 macOS 即使显式应用也不会写入", async (t) => {
  const { configPath } = await fixture(t);
  let writes = 0;
  await assert.rejects(
    provisionGeneratedKeychainSecrets({
      configPath,
      apply: true,
      platform: "linux",
      keychainWriter: async () => { writes += 1; },
    }),
    /requires macOS/u,
  );
  assert.equal(writes, 0);
});

test("回滚清理失败时明确要求人工核对且不泄露密钥", async (t) => {
  const { configPath } = await fixture(t);
  let leakedSecret;
  await assert.rejects(
    provisionGeneratedKeychainSecrets({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async (_service, account, secret) => {
        leakedSecret = secret;
        if (account === "backup-key") throw new Error(secret);
      },
      keychainReader: async () => leakedSecret,
      keychainDeleter: async () => { throw new Error(leakedSecret); },
    }),
    (error) => (
      error.message === "Keychain provisioning failed and cleanup is incomplete: AI_EMPLOYEE_BACKUP_KEY" &&
      !error.message.includes(leakedSecret)
    ),
  );
});

test("钥匙串写入脚本拒绝覆盖已有同名条目", async () => {
  const script = await readFile(new URL("../scripts/写入钥匙串.exp", import.meta.url), "utf8");
  assert.match(script, /add-generic-password -s \$service -a \$account/u);
  assert.doesNotMatch(script, /add-generic-password -U/u);
});

test("四项既有钥匙串密钥完整有效时重复应用只做回读", async (t) => {
  const { configPath } = await fixture(t);
  const values = [
    Buffer.alloc(32, 1).toString("base64"),
    Buffer.alloc(32, 2).toString("base64"),
    "r".repeat(64),
    "w".repeat(64),
  ];
  const accounts = ["data-key", "backup-key", "admin-read-token", "admin-write-token"];
  const entries = new Map(accounts.map((account, index) => [
    `ai-employee-test/${account}`,
    values[index],
  ]));
  let writes = 0;
  const result = await provisionGeneratedKeychainSecrets({
    configPath,
    apply: true,
    platform: "darwin",
    keychainWriter: async () => { writes += 1; },
    keychainReader: async (service, account) => entries.get(`${service}/${account}`),
  });
  assert.equal(result.completed, true);
  assert.equal(writes, 0);
  assert.equal(result.provisionedKeys.length, 0);
  assert.equal(result.alreadyProvisionedKeys.length, 4);
  for (const value of values) assert.equal(JSON.stringify(result).includes(value), false);
});

test("钥匙串只存在部分条目时在任何写入前停止", async (t) => {
  const { configPath } = await fixture(t);
  let writes = 0;
  await assert.rejects(
    provisionGeneratedKeychainSecrets({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async () => { writes += 1; },
      keychainReader: async (_service, account) => (
        account === "data-key" ? Buffer.alloc(32, 1).toString("base64") : undefined
      ),
    }),
    /manual cleanup: 1\/4/u,
  );
  assert.equal(writes, 0);
});

test("四项既有钥匙串内容不满足格式或独立性时拒绝复用", async (t) => {
  const { configPath } = await fixture(t);
  let writes = 0;
  await assert.rejects(
    provisionGeneratedKeychainSecrets({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async () => { writes += 1; },
      keychainReader: async () => "same-invalid-value",
    }),
    /failed validation/u,
  );
  assert.equal(writes, 0);
});

test("钥匙串命令写入后才报错时通过匹配回读清理当前项", async (t) => {
  const { configPath } = await fixture(t);
  const entries = new Map();
  await assert.rejects(
    provisionGeneratedKeychainSecrets({
      configPath,
      apply: true,
      platform: "darwin",
      keychainWriter: async (service, account, secret) => {
        entries.set(`${service}/${account}`, secret);
        throw new Error(secret);
      },
      keychainReader: async (service, account) => entries.get(`${service}/${account}`),
      keychainDeleter: async (service, account) => entries.delete(`${service}/${account}`),
    }),
    /Keychain provisioning failed: AI_EMPLOYEE_DATA_KEY/u,
  );
  assert.equal(entries.size, 0);
});
